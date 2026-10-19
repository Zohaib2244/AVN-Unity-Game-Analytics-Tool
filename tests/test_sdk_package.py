import gzip
import hashlib
import tarfile

import pytest
from fastapi.testclient import TestClient
from test_backend import AUDIENCE, AUTH, TEAM_DOMAIN, TOKEN

from avn_analytics import sdk_package
from avn_analytics.api import create_app
from avn_analytics.config import Settings


@pytest.fixture
def admin(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as client:
        yield client


def test_the_shipped_package_is_a_unity_package():
    with tarfile.open(sdk_package.PACKAGE, mode="r:gz") as archive:
        assert any(name.endswith("/pathname") for name in archive.getnames())


def test_the_sdk_package_is_listed_and_downloaded(admin):
    data = sdk_package.PACKAGE.read_bytes()
    assert gzip.decompress(data)
    listed = admin.get("/v1/sdk", headers=AUTH).json()
    assert listed == {
        "filename": "AVNAnalytics.unitypackage",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    download = admin.get("/v1/sdk/download", headers=AUTH)
    assert download.content == data
    assert 'filename="AVNAnalytics.unitypackage"' in download.headers["content-disposition"]


def test_the_sdk_package_cannot_be_changed_from_the_website(admin):
    assert admin.put("/v1/sdk", content=b"x", headers=AUTH).status_code == 405
    assert admin.delete("/v1/sdk", headers=AUTH).status_code == 405


def test_downloading_the_sdk_needs_a_sign_in(tmp_path):
    settings = Settings(
        data_dir=tmp_path,
        admin_token=TOKEN,
        access_team_domain=TEAM_DOMAIN,
        access_audience=AUDIENCE,
        lan_admin=False,
    )
    with TestClient(create_app(settings, admin=True, access_keys={})) as client:
        assert client.get("/v1/sdk").status_code == 401
        assert client.get("/v1/sdk/download").status_code == 401
