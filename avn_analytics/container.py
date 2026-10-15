"""Container startup: put SQLite query scratch files on the writable data disk."""

import os
import sys
from pathlib import Path
from tempfile import TemporaryFile


def main():
    command = sys.argv[1:]
    if not command:
        raise SystemExit("Container startup requires a command")
    directory = Path(
        os.environ.get("SQLITE_TMPDIR")
        or Path(os.environ.get("AVN_DATA_DIR", "/data")) / "sqlite-tmp"
    ).resolve()
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Check real file creation and writes as the container's runtime UID. SQLite can otherwise
        # silently fall back to /tmp when its preferred directory cannot be used.
        with TemporaryFile(dir=directory) as probe:
            probe.write(b"sqlite scratch check")
            probe.flush()
    except OSError as error:
        raise SystemExit(
            f"SQLite temporary storage is unavailable at {directory}: {error.strerror}"
        ) from error
    os.environ["SQLITE_TMPDIR"] = str(directory)
    os.execvp(command[0], command)


if __name__ == "__main__":
    main()
