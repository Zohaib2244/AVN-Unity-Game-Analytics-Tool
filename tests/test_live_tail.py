from test_backend import AUTH, backend, event, register, send  # noqa: F401

from avn_analytics import live_tail
from avn_analytics.storage import Storage


def _sent(ingest, game, events):
    response = send(ingest, game, events)
    assert response.status_code == 202 or response.status_code == 200, response.text


def _live(admin, game, **params):
    response = admin.get(f"/v1/games/{game['id']}/events/live", headers=AUTH, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_first_look_then_only_what_arrived_since(backend):  # noqa: F811
    admin, ingest, _ = backend
    game = register(admin)
    _sent(ingest, game, [event(name=f"e{n}", params={"n": n}) for n in range(5)])
    first = _live(admin, game, limit=3)
    assert [item["name"] for item in first["events"]] == ["e2", "e3", "e4"]
    assert first["events"][0]["params"] == {"n": 2}
    assert _live(admin, game, after=first["cursor"])["events"] == []
    _sent(ingest, game, [event(name="e5"), event(name="e6")])
    later = _live(admin, game, after=first["cursor"])
    assert [item["name"] for item in later["events"]] == ["e5", "e6"]
    assert later["cursor"] > first["cursor"]


def test_a_full_page_resumes_where_it_stopped(backend):  # noqa: F811
    admin, ingest, _ = backend
    game = register(admin)
    _sent(ingest, game, [event(name="old")])
    cursor = _live(admin, game)["cursor"]
    _sent(ingest, game, [event(name=f"n{n}") for n in range(5)])
    page = _live(admin, game, after=cursor, limit=2)
    assert [item["name"] for item in page["events"]] == ["n0", "n1"]
    rest = _live(admin, game, after=page["cursor"], limit=10)
    assert [item["name"] for item in rest["events"]] == ["n2", "n3", "n4"]


def test_narrowed_to_one_player_by_user_or_device_id(backend):  # noqa: F811
    admin, ingest, _ = backend
    game = register(admin)
    _sent(
        ingest,
        game,
        [
            event(name="mine", device_id="dev-a"),
            event(name="other", device_id="dev-b"),
            event(name="by_user", device_id="dev-c", user_id="user-1"),
        ],
    )
    assert [item["name"] for item in _live(admin, game, player="dev-a")["events"]] == ["mine"]
    assert [item["name"] for item in _live(admin, game, player="user-1")["events"]] == ["by_user"]
    first = _live(admin, game, player="dev-a")
    _sent(ingest, game, [event(name="b2", device_id="dev-b"), event(name="a2", device_id="dev-a")])
    assert [
        item["name"] for item in _live(admin, game, player="dev-a", after=first["cursor"])["events"]
    ] == ["a2"]


def test_reading_writes_nothing_and_limit_is_capped(backend):  # noqa: F811
    admin, ingest, settings = backend
    game = register(admin)
    _sent(ingest, game, [event(name="x")])
    storage = Storage(settings)
    path = storage.game_path(game["id"])
    before = path.stat().st_mtime_ns
    result = live_tail.tail(storage, game["id"], limit=10_000)
    assert len(result["events"]) == 1
    assert path.stat().st_mtime_ns == before
    assert live_tail.MAX_EVENTS == 200
