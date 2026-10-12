# Sourced by the other scripts. The app needs SQLite 3.51.3+ (WAL-reset fix);
# when the system library is older, setup.sh builds the same pinned version the
# Dockerfile uses into a per-user cache, shared by every checkout/worktree.
SQLITE_TARBALL=sqlite-autoconf-3510300
SQLITE_URL="https://www.sqlite.org/2026/$SQLITE_TARBALL.tar.gz"
SQLITE_SHA256=81f5be397049b0cae1b167f2225af7646fc0f82e4a9b3c48c9ea3a533e21d77a
SQLITE_PREFIX="${XDG_CACHE_HOME:-$HOME/.cache}/avn-analytics/$SQLITE_TARBALL"

if [ -f "$SQLITE_PREFIX/lib/libsqlite3.so.0" ]; then
  export LD_LIBRARY_PATH="$SQLITE_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

sqlite_ok() {
  .venv/bin/python - <<'PY'
import sqlite3, sys
v = sqlite3.sqlite_version_info
ok = v >= (3, 51, 3) or (v[:2] == (3, 50) and v >= (3, 50, 7)) or (v[:2] == (3, 44) and v >= (3, 44, 6))
sys.exit(0 if ok else 1)
PY
}
