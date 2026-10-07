import pytest
from fastapi.testclient import TestClient

from avn_analytics.api import create_app
from avn_analytics.config import Settings


@pytest.fixture
def website(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token="a" * 48)
    with TestClient(create_app(settings, admin=True), base_url="http://localhost") as client:
        yield client, settings


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
    ]:
        response = client.get(page)
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/assets/style.css").status_code == 200
    assert client.get("/v1/overview").status_code == 200
    with TestClient(create_app(settings)) as ingest:
        assert ingest.get("/").status_code == 404
        assert ingest.get("/assets/app.js").status_code == 404


def test_no_login_routes_and_writes_from_any_host(website):
    client, _ = website
    for path in ("/login", "/auth/status", "/auth/setup", "/auth/login", "/auth/logout"):
        assert client.get(path).status_code == 404
    payload = {"name": "Game", "bundle_id": "com.avn.game", "platform": "android"}
    app = create_app(website[1], admin=True)
    with TestClient(app, base_url="http://analytics.example.lan") as lan:
        assert lan.post("/v1/games", json=payload).status_code == 201
