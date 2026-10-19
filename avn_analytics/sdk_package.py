"""The Unity SDK package, uploaded from the website and offered for download.

One file per server, kept in the data directory next to the databases. The package is a build
artifact made in Unity, so it is not part of the repository: an admin uploads the current build
and everyone who can open the website can download it.
"""

import hashlib
import io
import json
import tarfile
from datetime import UTC, datetime

from fastapi import HTTPException

FILENAME = "AVNAnalytics.unitypackage"
MAX_BYTES = 64 * 1024 * 1024


def _paths(storage):
    folder = storage.root / "sdk"
    return folder, folder / FILENAME, folder / "info.json"


def info(storage):
    """What is stored, or `{"available": False}`."""
    _, package, meta = _paths(storage)
    if not package.exists() or not meta.exists():
        return {"available": False}
    return {"available": True, "filename": FILENAME, **json.loads(meta.read_text())}


def path(storage):
    _, package, _ = _paths(storage)
    return package if package.exists() else None


def _check(data):
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "The package is too large (limit 64 MB)")
    if data[:2] != b"\x1f\x8b":
        raise HTTPException(
            415, "Not a Unity package: choose the .unitypackage file exported from Unity"
        )
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            found = any(name.endswith("/pathname") for name in archive.getnames())
    except (tarfile.TarError, OSError, EOFError) as error:
        raise HTTPException(415, "Not a Unity package: the file can't be read") from error
    if not found:
        raise HTTPException(415, "Not a Unity package: it contains no Unity assets")


def save(storage, data, version, person):
    _check(data)
    folder, package, meta = _paths(storage)
    folder.mkdir(exist_ok=True, mode=0o700)
    temporary = package.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(package)
    record = {
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "version": version,
        "uploaded_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "uploaded_by": person,
    }
    meta.write_text(json.dumps(record))
    return info(storage)


def clear(storage):
    _, package, meta = _paths(storage)
    existed = package.exists()
    package.unlink(missing_ok=True)
    meta.unlink(missing_ok=True)
    return existed
