"""The Unity SDK package shipped with the app.

`sdk/AVNAnalytics.unitypackage` is a build made in Unity and committed to the repository. The
website hands it out as it is, next to the events standard setup files.
"""

import hashlib
from functools import cache
from pathlib import Path

FILENAME = "AVNAnalytics.unitypackage"
PACKAGE = Path(__file__).parent / "sdk" / FILENAME


@cache
def info():
    data = PACKAGE.read_bytes()
    return {"filename": FILENAME, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
