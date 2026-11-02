"""Exercise copied owner scripts with fake git/Docker; never release or deploy anything."""

import json
import os
import pty
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FAKE_COMMAND = r"""
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['SCRIPT_CALLS'], 'a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'docker':
    if args[0] == 'inspect':
        print('healthy')
    elif args[0] == 'compose' and args[-2:] == ['ps', '-q']:
        print('sample-container')
    sys.exit(0)
if args[:1] == ['-C']:
    args = args[2:]
if args[:2] == ['branch', '--show-current']:
    print('main')
elif args[:2] == ['tag', '-l']:
    print('v1.2.3')
elif args == ['rev-parse', 'HEAD']:
    print('old-head' if os.environ.get('ALREADY_RELEASED') == '1' else 'new-head')
elif args[:2] == ['rev-list', '-n1']:
    print('old-head')
elif args[:3] == ['rev-parse', '-q', '--verify']:
    tag = args[-1].removeprefix('refs/tags/')
    if tag not in ('v1.2.2', 'v1.2.3') and not Path(os.environ['CREATED_TAG']).exists():
        sys.exit(1)
elif args[:2] == ['tag', '-a']:
    Path(os.environ['CREATED_TAG']).write_text(args[2])
"""


@pytest.fixture
def sandbox(tmp_path):
    checkout = tmp_path / "dev checkout"
    scripts = checkout / "scripts"
    scripts.mkdir(parents=True)
    for name in ("deploy.sh", "release.sh"):
        shutil.copy2(ROOT / "scripts" / name, scripts / name)
    gate = scripts / "check.sh"
    gate.write_text('#!/usr/bin/env bash\nexit "${GATE_EXIT:-0}"\n')
    gate.chmod(0o755)
    app = tmp_path / "apps" / "avn-analytics"
    (app / "src" / ".git").mkdir(parents=True)
    (app / "config").mkdir()
    for name in (".env", "compose.override.yaml"):
        (app / "config" / name).touch()
    (app / ".deployed").write_text("v1.2.3\n")
    (app / ".previous").write_text("v1.2.2\n")
    binaries = tmp_path / "fake bin"
    binaries.mkdir()
    for name in ("git", "docker"):
        command = binaries / name
        command.write_text(f"#!{sys.executable}\n" + FAKE_COMMAND)
        command.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    environment = {
        **os.environ,
        "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
        "AVNS_APPS_ROOT": str(app.parent),
        "SCRIPT_CALLS": str(calls),
        "CREATED_TAG": str(tmp_path / "created-tag"),
    }
    return checkout, environment, calls


def run_script(sandbox, script, args=(), answer="y", **overrides):
    checkout, environment, calls = sandbox
    master, terminal = pty.openpty()
    try:
        process = subprocess.Popen(
            ["bash", str(checkout / "scripts" / script), *args],
            cwd=checkout,
            env={**environment, **overrides},
            stdin=terminal if answer is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        if answer is not None:
            os.write(master, (answer + "\n").encode())
        try:
            output, _ = process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            pytest.fail("script did not finish with a single answer")
    finally:
        os.close(master)
        os.close(terminal)
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    return process.returncode, output, recorded


def mutations(calls):
    return [
        call
        for call in calls
        if call[0] == "docker"
        or (call[0] == "git" and (call[1:3] == ["tag", "-a"] or call[1] == "push"))
    ]


@pytest.mark.parametrize("already", ["0", "1"])
def test_combined_deploy_asks_once_and_deploys_the_exact_release(sandbox, already):
    code, output, calls = run_script(sandbox, "deploy.sh", ("--release",), ALREADY_RELEASED=already)
    assert code == 0, output
    assert output.count("[y/N]") == 1
    target = "v1.2.3" if already == "1" else "v1.2.4"
    if already == "0":
        assert "push main + tag, and deploy v1.2.4 to the live server?" in output
    assert f"deployed {target}, healthy" in output
    assert any(call[-4:] == ["checkout", "--quiet", "--detach", target] for call in calls)
    pushes = [call for call in calls if call[:2] == ["git", "push"]]
    assert pushes == ([] if already == "1" else [["git", "push", "origin", "main", target]])


@pytest.mark.parametrize("already", ["0", "1"])
def test_declining_combined_deploy_does_not_publish_or_change_containers(sandbox, already):
    code, output, calls = run_script(
        sandbox, "deploy.sh", ("--release",), answer="n", ALREADY_RELEASED=already
    )
    assert code != 0
    assert output.count("[y/N]") == 1
    assert not mutations(calls)


@pytest.mark.parametrize("args", [("v1.2.3",), ("--rollback",)])
def test_standalone_deploy_and_rollback_keep_one_confirmation(sandbox, args):
    code, output, _ = run_script(sandbox, "deploy.sh", args)
    assert code == 0, output
    assert output.count("[y/N]") == 1


def test_noninteractive_combined_deploy_requires_explicit_yes(sandbox):
    code, output, calls = run_script(sandbox, "deploy.sh", ("--release",), answer=None)
    assert code != 0
    assert "needs a terminal to confirm" in output
    assert not mutations(calls)
    code, output, _ = run_script(sandbox, "deploy.sh", ("--release", "--yes"), answer=None)
    assert code == 0, output
    assert "[y/N]" not in output


def test_failed_release_checks_prevent_publish_and_deploy(sandbox):
    code, output, calls = run_script(sandbox, "deploy.sh", ("--release",), GATE_EXIT="1")
    assert code != 0
    assert "[y/N]" not in output
    assert not mutations(calls)
