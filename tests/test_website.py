import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from avn_analytics.api import create_app
from avn_analytics.config import Settings

PASSWORD = "correct-horse-private-workspace"
ORIGIN = {"Origin": "http://localhost"}


@pytest.fixture
def website(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token="a" * 48)
    with TestClient(create_app(settings, admin=True), base_url="http://localhost") as client:
        yield client, settings


def setup(client):
    return client.post("/auth/setup", headers=ORIGIN, json={"password": PASSWORD})


def test_pages_assets_and_api_separation(website):
    client, settings = website
    for page in [
        "/",
        "/games",
        "/games/new",
        "/keys",
        "/exports",
        "/dictionary",
        "/status",
        "/settings",
        "/login",
    ]:
        response = client.get(page)
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/assets/style.css").status_code == 200
    assert client.get("/v1/overview").status_code == 401
    with TestClient(create_app(settings)) as ingest:
        assert ingest.get("/").status_code == 404
        assert ingest.get("/auth/status").status_code == 404
        assert ingest.get("/assets/app.js").status_code == 404


def test_setup_session_and_persistence(website):
    client, settings = website
    assert client.get("/auth/status").json() == {"configured": False, "authenticated": False}
    response = setup(client)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert client.get("/v1/overview").status_code == 200
    assert setup(client).status_code == 409
    with TestClient(create_app(settings, admin=True), base_url="http://localhost") as restarted:
        restarted.cookies.update(client.cookies)
        assert restarted.get("/v1/overview").status_code == 200
        assert restarted.get("/auth/status").json()["configured"] is True
    with client.app.state.storage.connect(settings.data_dir / "registry.sqlite3") as connection:
        dump = "\n".join(connection.iterdump())
        assert PASSWORD not in dump
        assert client.cookies.get("avn_session") not in dump


def test_csrf_protection(website):
    client, _ = website
    assert client.post("/auth/setup", json={"password": PASSWORD}).status_code == 403
    assert (
        client.post(
            "/auth/setup", headers={"Origin": "https://evil.example"}, json={"password": PASSWORD}
        ).status_code
        == 403
    )
    assert setup(client).status_code == 200
    payload = {"name": "Private game", "bundle_id": "com.avn.private", "platform": "android"}
    assert client.post("/v1/games", json=payload).status_code == 403
    assert client.post("/v1/games", json=payload, headers=ORIGIN).status_code == 201
    assert client.get("/v1/overview").json()["active_keys"] == 1


def test_logout_invalidates_session_and_password_login(website):
    client, _ = website
    setup(client)
    old_cookie = client.cookies.get("avn_session")
    assert client.post("/auth/logout", headers=ORIGIN).status_code == 200
    client.cookies.set("avn_session", old_cookie)
    assert client.get("/v1/overview").status_code == 401
    assert (
        client.post(
            "/auth/login", headers=ORIGIN, json={"password": "wrong-password-long"}
        ).status_code
        == 401
    )
    client.cookies.clear()
    assert (
        client.post("/auth/login", headers=ORIGIN, json={"password": PASSWORD}).status_code == 200
    )
    assert client.get("/v1/overview").status_code == 200


def test_expired_session_denied(website):
    client, settings = website
    setup(client)
    digest = hashlib.sha256(client.cookies.get("avn_session").encode()).hexdigest()
    with client.app.state.storage.connect(settings.data_dir / "registry.sqlite3") as connection:
        connection.execute(
            "UPDATE web_sessions SET expires=? WHERE hash=?", (time.time() - 1, digest)
        )
    assert client.get("/v1/overview").status_code == 401


def test_login_rate_limited(website):
    client, _ = website
    setup(client)
    for _ in range(9):
        assert (
            client.post(
                "/auth/login", headers=ORIGIN, json={"password": "incorrect-password"}
            ).status_code
            == 401
        )
    response = client.post("/auth/login", headers=ORIGIN, json={"password": PASSWORD})
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
