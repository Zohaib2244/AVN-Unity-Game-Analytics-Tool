"""Levels must reuse event meanings and avoid rescanning long player histories."""

import json

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
    assert labeler.calls == 2


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
