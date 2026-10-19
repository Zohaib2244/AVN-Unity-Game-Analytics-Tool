import gzip
import io
import tarfile

import pytest
from fastapi.testclient import TestClient
from test_backend import AUDIENCE, AUTH, TEAM_DOMAIN, TOKEN

from avn_analytics.api import create_app
from avn_analytics.config import Settings


def unity_package(entries=("abc/pathname", "abc/asset")):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name in entries:
            body = b"Assets/AVNAnalytics/Scripts/Thing.cs"
            member = tarfile.TarInfo(name)
            member.size = len(body)
            archive.addfile(member, io.BytesIO(body))
    return buffer.getvalue()


@pytest.fixture
def admin(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as client:
        yield client


def test_the_sdk_package_is_uploaded_listed_downloaded_and_removed(admin):
    assert admin.get("/v1/sdk", headers=AUTH).json() == {"available": False}
    assert admin.get("/v1/sdk/download", headers=AUTH).status_code == 404

    package = unity_package()
    saved = admin.put("/v1/sdk?version=1.2.0", content=package, headers=AUTH)
    assert saved.is_success
    assert saved.json()["size"] == len(package) and saved.json()["version"] == "1.2.0"
    assert admin.get("/v1/sdk", headers=AUTH).json()["available"] is True

    download = admin.get("/v1/sdk/download", headers=AUTH)
    assert download.content == package
    assert 'filename="AVNAnalytics.unitypackage"' in download.headers["content-disposition"]

    replacement = unity_package(("xyz/pathname",))
    assert admin.put("/v1/sdk", content=replacement, headers=AUTH).json()["version"] == ""
    assert admin.get("/v1/sdk/download", headers=AUTH).content == replacement

    assert admin.delete("/v1/sdk", headers=AUTH).is_success
    assert admin.delete("/v1/sdk", headers=AUTH).status_code == 404
    assert admin.get("/v1/sdk", headers=AUTH).json() == {"available": False}


@pytest.mark.parametrize(
    "body, status",
    [
        (b"hello", 415),
        (gzip.compress(b"not a tar file"), 415),
        (unity_package(("README.md",)), 415),
    ],
)
def test_files_that_are_not_unity_packages_are_refused(admin, body, status):
    assert admin.put("/v1/sdk", content=body, headers=AUTH).status_code == status
    assert admin.get("/v1/sdk", headers=AUTH).json() == {"available": False}


def test_only_the_admin_uploads_the_sdk_and_signing_in_is_needed_to_download(tmp_path):
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
        assert client.put("/v1/sdk", content=unity_package()).status_code == 401
        assert client.delete("/v1/sdk").status_code == 401
        assert client.put("/v1/sdk", content=unity_package(), headers=AUTH).is_success
