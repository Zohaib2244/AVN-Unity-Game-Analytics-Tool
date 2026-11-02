"""scripts/nutbot_usage.py sums up stored answers without printing any of their contents."""

import importlib.util
import json
from pathlib import Path

from avn_analytics.config import Settings
from avn_analytics.nutbot_chats import Chats
from avn_analytics.storage import Storage

SCRIPT = Path(__file__).parent.parent / "scripts" / "nutbot_usage.py"
spec = importlib.util.spec_from_file_location("nutbot_usage", SCRIPT)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


def registry_with_answers(tmp_path):
    storage = Storage(Settings(data_dir=tmp_path, admin_token="b" * 40))
    storage.initialize()
    chats = Chats(storage)
    chats.initialize()
    chat = chats.create("game", "owner@example.com", "claude", "model")
    exits = {
        "tool": "get_exits",
        "input": "{}",
        "ok": True,
        "ms": 0,
        "server_ms": 100,
        "chars": 900,
        "cut": True,
        "output": "x" * 2000,
    }
    failed = {
        "tool": "get_level_detail",
        "ok": False,
        "server_ms": 300,
        "error": "Bad arguments for 1aac03ef0123456789ab3f6d18",
    }
    chats.add_assistant(
        chat["id"],
        {
            "text": "A secret finding. I can't tell why they left.",
            "tools": [exits, exits, failed],
            "seconds": 12.5,
            "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 90},
        },
    )
    chats.add_assistant(chat["id"], {"text": "Level 7.", "tools": [], "seconds": 2.5})
    return chats.registry


def test_totals_per_tool_and_answer(tmp_path):
    report = usage.summarise(usage.read_answers(registry_with_answers(tmp_path), 30))
    assert report["answers"] == 2 and report["said_unsure"] == 1
    assert report["tools_per_answer_most"] == 3 and report["repeated_calls"] == 1
    assert report["input_tokens"] == 10 and report["cached_input_tokens"] == 90
    assert report["tools"]["get_exits"]["calls"] == 2
    assert report["tools"]["get_exits"]["large"] == 2
    assert report["tools"]["get_exits"]["cut"] == 2
    assert report["tools"]["get_exits"]["ms_median"] == 100
    assert report["tools"]["get_exits"]["chars_median"] == 900
    failed = report["tools"]["get_level_detail"]
    assert failed["failed"] == 1 and failed["errors"] == [("Bad arguments for <id>", 1)]
    assert report["first_tools"][0] == ("get_exits > get_exits > get_level_detail", 1)


def test_the_report_holds_no_answer_text(tmp_path, capsys):
    report = usage.summarise(usage.read_answers(registry_with_answers(tmp_path), 30))
    usage.show(report, 30)
    printed = capsys.readouterr().out + json.dumps(report)
    assert "secret" not in printed and "get_exits" in printed


def test_the_registry_cannot_be_written(tmp_path):
    registry = registry_with_answers(tmp_path)
    before = registry.read_bytes()
    usage.read_answers(registry, 30)
    assert registry.read_bytes() == before
