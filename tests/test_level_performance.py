"""Levels must reuse event meanings and avoid rescanning long player histories."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from avn_analytics import journeys, stories


class CountingLabeler(stories.Labeler):
    def __init__(self, definitions=None):
        super().__init__(definitions)
        self.calls = 0

    def _level_info(self, *args):
        self.calls += 1
        return super()._level_info(*args)


def test_sequence_numbers_and_ad_metadata_do_not_repeat_level_interpretation():
    labeler = CountingLabeler()
    reader = journeys._Reader(labeler)
    for seq in range(500):
        params = {"seq": seq, "STATE": "Show", "AD_ID": str(seq), "REVENUE": seq / 1000}
        actual, info = reader.level("AD_ANALYSIS", json.dumps(params), "1.0")
        assert actual == params and info is None
        labeler.label("AD_ANALYSIS", params, "1.0")
        stories.action_text(labeler, "AD_ANALYSIS", params, "1.0")
        params = {"seq": seq, "STATE": "Started", "LEVEL_NUMBER": 3, "SECONDS": seq}
        actual, info = reader.level("LEVEL_ANALYSIS", json.dumps(params), "1.0")
        assert actual == params and info == ("started", 3)
    assert labeler.calls == 1  # unmapped non-level names need no parameter interpretation at all


def test_level_meaning_cache_preserves_mapping_inputs_versions_and_parameter_order():
    definitions = {
        "custom": {
            "canonical": [
                {"action": "level_started", "param": "seq", "value": "1", "number_param": "n"},
                {"action": "level_failed", "number_param": "n", "app_version": "2.0"},
            ]
        }
    }
    reader = journeys._Reader(stories.Labeler(definitions))
    expected = stories.Labeler(definitions)
    cases = [
        ("custom", {"seq": 1, "n": 3}, "1.0"),
        ("custom", {"seq": 2, "n": 3}, "1.0"),
        ("custom", {"seq": 1, "n": 4}, "1.0"),
        ("custom", {"seq": 1, "n": 3}, "2.0"),
        ("custom", {"SEQ": 1, "N": 3}, "1.0"),
        ("level_start", {"level": 2, "number": 3}, None),
        ("level_start", {"number": 3, "level": 2}, None),
        ("level", {"STATE": "Started", "LEVEL_NUMBER": 3}, None),
        ("level", {"STATE": "Failed", "LEVEL_NUMBER": 3}, None),
        ("custom", {"Started": 3}, None),
        ("level", {"Started": 3}, None),
    ]
    for name, params, version in cases * 2:
        actual, info = reader.level(name, json.dumps(params), version)
        assert actual == params
        assert info == expected._level_info(name, params, version)


def test_captions_reuse_meanings_despite_unique_sdk_metadata(monkeypatch):
    class Counted(stories.Labeler):
        calls = 0

        def label(self, *args):
            self.calls += 1
            return super().label(*args)

    labeler = Counted()
    reader = journeys._Reader(labeler)
    calls = []
    action = stories.action_text

    def counted(*args):
        calls.append(1)
        return action(*args)

    monkeypatch.setattr(stories, "action_text", counted)
    for seq in range(500):
        params = {"seq": seq, "STATE": "Show", "FORMAT": "Interstitial", "AD_ID": str(seq)}
        row = {"name": "AD_ANALYSIS", "params": json.dumps(params), "app_version": "1.0"}
        assert reader.label(row) == "AD · Show Interstitial"
        assert reader.action(row) == "Interstitial ad"
    assert labeler.calls == len(calls) == 1


def test_label_cache_ignores_snapshot_values_after_the_three_displayed_parts():
    reader = journeys._Reader(stories.Labeler())
    for value in range(100):
        params = {"STATE": "Snapshot", "coins": 10, "gems": 2, "unused_balance": value}
        row = {"name": "PLAYER_ANALYSIS", "params": json.dumps(params), "app_version": "1.0"}
        assert reader.label(row) == "Player · Snapshot coins 10 gems 2"
    assert len(reader._labels) == 1
    # Lifecycle inputs still matter even when they follow three other displayed fields.
    for level in (1, 2):
        params = {"a": 1, "b": 2, "c": 3, "STATE": "Started", "LEVEL_NUMBER": level}
        row = {"name": "LEVEL_ANALYSIS", "params": json.dumps(params), "app_version": "1.0"}
        assert reader.label(row) == f"Started level {level}"
    # Required lifecycle fields must not erase their position in an ordinary caption.
    for params in ({"a": 1, "level": 2, "b": 3}, {"level": 2, "a": 1, "b": 3}):
        row = {"name": "custom", "params": json.dumps(params), "app_version": "1.0"}
        assert reader.label(row) == stories.Labeler().label("custom", params, "1.0")


@pytest.mark.parametrize(
    "definition",
    [
        {},
        {"labels": "ID => Seen {ID} at {SECONDS}"},
        {"labels": "* => Seen {ID} at {SECONDS}"},
        {
            "canonical": [
                {"action": "level_started", "param": "ID", "value": "1", "number_param": "SECONDS"}
            ]
        },
        {"canonical": [{"action": "level_failed", "number_param": "ID", "app_version": "2.0"}]},
    ],
)
def test_caption_projection_preserves_custom_rules_types_versions_and_parameter_order(definition):
    labeler = stories.Labeler({"level_custom": definition})
    reader = journeys._Reader(labeler)
    for version in ("1.0", "2.0"):
        for value in (1, 1.0, "1", 2, "Different"):
            params = {"seq": value, "ID": value, "SECONDS": value, "STATE": "Started", "level": 3}
            for ordered in (params, dict(reversed(list(params.items())))):
                row = {
                    "name": "level_custom",
                    "params": json.dumps(ordered),
                    "app_version": version,
                }
                assert reader.label(row) == labeler.label(row["name"], ordered, version)
                assert reader.action(row) == stories.action_text(
                    labeler, row["name"], params, version
                )


def test_unique_payload_caches_stay_bounded_without_changing_answers(monkeypatch):
    monkeypatch.setattr(stories, "MEMO_LIMIT", 16)
    reader = journeys._Reader(stories.Labeler())
    for seq in range(200):
        params = {"seq": seq, "STATE": "Started", "LEVEL_NUMBER": seq}
        raw = json.dumps(params)
        row = {"name": "LEVEL_ANALYSIS", "params": raw, "app_version": "1.0"}
        assert reader.level(row["name"], raw, "1.0") == (params, ("started", seq))
        assert reader.label(row) == reader.action(row) == f"Started level {seq}"
        reader.text(row)
        for cache in (*vars(reader).values(), *vars(reader.labeler).values()):
            if isinstance(cache, stories._Memo):
                assert len(cache) <= cache.limit


def long_session():
    rows = []
    origin = datetime(2026, 1, 1, tzinfo=UTC)
    for number in range(1, 21):
        for name, params in (
            ("LEVEL_ANALYSIS", {"STATE": "Started", "LEVEL_NUMBER": number}),
            ("SCREEN_ANALYSIS", {"STATE": "Opened", "SCREEN": "shop"}),
            ("LEVEL_ANALYSIS", {"STATE": "Completed", "LEVEL_NUMBER": number}),
        ):
            moment = origin + timedelta(seconds=len(rows))
            rows.append(
                {
                    "name": name,
                    "params": json.dumps(params),
                    "app_version": "1.0",
                    "country": "US",
                    "client_ts": moment.isoformat(),
                    "server_ts": moment.isoformat(),
                    "ts": moment.timestamp(),
                    "event_id": str(len(rows)),
                    "seq": len(rows),
                    "session_id": "one",
                    "selected": True,
                }
            )
    return rows


def test_table_defers_player_detail_captions_and_pagination_preserves_cached_records(monkeypatch):
    rows = long_session()
    calls = []
    action = stories.action_text

    def counted(*args):
        calls.append(1)
        return action(*args)

    monkeypatch.setattr(stories, "action_text", counted)
    reader = journeys._Reader(stories.Labeler(), defer_details=True)
    deferred = journeys.player_levels("player", rows, None, "all", rows[0]["client_ts"], reader)
    assert not calls  # the table never asks for any player's next-action caption
    record = deferred["groups"][1]["started"]
    groups = {name: [] for name in journeys.LEVEL_GROUPS}
    groups["started"] = [{**record, "player": str(index)} for index in range(20)]
    page = journeys.players_in_group(
        groups, 1, "started", 0, 3, "exit_at", None, reader=journeys._Reader(stories.Labeler())
    )
    assert len(page["players"]) == 3 and len(calls) == 1
    assert all(row["next_action"] == "Started level 2" for row in page["players"])
    assert isinstance(record["next_action"], journeys._PendingText)
    eager_reader = journeys._Reader(stories.Labeler())
    eager = journeys.player_levels("player", rows, None, "all", rows[0]["client_ts"], eager_reader)
    assert journeys._resolved_player(record, eager_reader) == eager["groups"][1]["started"]
    assert deferred["progress"] == eager["progress"] and deferred["features"] == eager["features"]


def test_levels_calculate_a_sessions_seconds_once(monkeypatch):
    class Counted(journeys.SessionState):
        calls = 0

        @property
        def seconds(self):
            Counted.calls += 1
            return super().seconds

    monkeypatch.setattr(journeys, "SessionState", Counted)
    rows = long_session()
    journeys.player_levels(
        "player", rows, None, "all", rows[0]["client_ts"], journeys._Reader(stories.Labeler())
    )
    assert Counted.calls == 1


def test_summary_memory_is_bounded_by_retained_state_and_exact_samples():
    rows = long_session()
    part = journeys.player_levels(
        "player", rows, None, "all", rows[0]["client_ts"], journeys._Reader(stories.Labeler())
    )
    for progress in part["progress"].values():
        progress["seconds"] = []
    summary = journeys._LevelSummary()
    summary.add(part)
    initial = summary.memory_used
    summary.memory_budget = initial
    for _ in range(1000):
        summary.add(part)
    assert summary.memory_used == initial
    assert summary.levels[1]["started"] == 1001
    part["progress"][1]["seconds"] = [1.5]
    with pytest.raises(ValueError, match="memory budget"):
        summary.add(part)


def test_occurrence_session_exit_work_is_linear_in_player_history():
    class CountedHistory(list):
        visits = 0

        def __iter__(self):
            for item in super().__iter__():
                self.visits += 1
                yield item

    features = journeys._Features()
    events = CountedHistory()
    groups = {}
    for number in range(1, 501):
        row = {"session_id": "one", "name": "LEVEL_ANALYSIS", "selected": True}
        info = ("started", number)
        features.step(len(events), row, {}, info, None, False)
        events.append((row, info))
        groups[number] = {"started": {}}
    result = features.finish(events, groups)
    assert result[1]["*"][2] == 0
    assert result[500]["*"][2] == 1
    assert events.visits <= len(events) * 2


def test_occurrence_session_exit_uses_last_level_event_even_when_it_is_not_selected():
    features = journeys._Features()
    events = []
    steps = [
        ("s1", 1, "started", True),
        ("s1", 2, "started", True),
        ("s2", 1, "completed", False),
        ("s3", 2, "started", False),
    ]
    for session, number, verb, selected in steps:
        row = {"session_id": session, "name": "LEVEL_ANALYSIS", "selected": selected}
        info = (verb, number)
        features.step(len(events), row, {}, info, None, False)
        events.append((row, info))
    result = features.finish(events, {1: {"started": {}}, 2: {"started": {}}})
    assert result[1]["*"][2] == 1
    assert result[2]["*"][2] == 1
