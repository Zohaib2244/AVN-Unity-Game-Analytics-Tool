"""Container startup must keep SQLite spills off the small /tmp tmpfs."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from avn_analytics import container


def launch(tmp_path, command, override=None):
    environment = dict(os.environ, AVN_DATA_DIR=str(tmp_path / "data"))
    environment.pop("SQLITE_TMPDIR", None)
    if override is not None:
        environment["SQLITE_TMPDIR"] = str(override)
    return subprocess.run(
        [sys.executable, "-m", "avn_analytics.container", sys.executable, "-c", command],
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
    )


@pytest.mark.parametrize("custom", [False, True])
def test_container_prepares_private_disk_scratch_and_passes_it_to_command(tmp_path, custom):
    override = tmp_path / "other disk" / "scratch" if custom else None
    expected = override or tmp_path / "data" / "sqlite-tmp"
    response = launch(
        tmp_path,
        "import json,os,stat; from pathlib import Path; "
        "p=Path(os.environ['SQLITE_TMPDIR']); "
        "print(json.dumps({'directory':str(p), 'mode':stat.S_IMODE(p.stat().st_mode), "
        "'files':[f.name for f in p.iterdir()]}))",
        override,
    )
    assert response.returncode == 0, response.stderr
    assert json.loads(response.stdout) == {"directory": str(expected), "mode": 0o700, "files": []}


def test_container_does_not_launch_app_when_scratch_is_unusable(tmp_path):
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("preserve this file")
    sentinel = tmp_path / "app-started"
    result = launch(tmp_path, f"open({str(sentinel)!r}, 'w').close()", blocker)
    assert result.returncode != 0
    assert "SQLite temporary storage is unavailable" in result.stderr
    assert not sentinel.exists()
    assert blocker.read_text() == "preserve this file"


def test_container_does_not_launch_app_when_scratch_writes_fail(tmp_path, monkeypatch):
    directory = tmp_path / "scratch"
    monkeypatch.setenv("SQLITE_TMPDIR", str(directory))
    monkeypatch.setattr(sys, "argv", ["container", "must-not-launch"])

    def full(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(container, "TemporaryFile", full)
    with pytest.raises(SystemExit, match="SQLite temporary storage.*No space left"):
        container.main()


@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="Linux open-file inspection")
def test_sqlite_actually_spills_to_the_configured_disk_directory(tmp_path):
    result = launch(
        tmp_path,
        """
import os, sqlite3
from pathlib import Path
connection = sqlite3.connect(':memory:')
connection.execute('PRAGMA temp_store=FILE')
connection.execute('CREATE TEMP TABLE scratch (payload BLOB)')
connection.executemany('INSERT INTO scratch VALUES (zeroblob(65536))', [()] * 80)
directory = os.environ['SQLITE_TMPDIR'] + '/'
opened = []
for descriptor in Path('/proc/self/fd').iterdir():
    try:
        opened.append(os.readlink(descriptor))
    except FileNotFoundError:
        pass
assert any(path.startswith(directory) for path in opened), opened
assert connection.execute('SELECT count(*) FROM scratch').fetchone()[0] == 80
connection.close()
assert not list(Path(directory).iterdir()), 'SQLite should remove its query scratch files'
""",
    )
    assert result.returncode == 0, result.stderr
