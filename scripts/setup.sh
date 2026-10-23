#!/usr/bin/env bash
# Create .venv and install runtime + dev dependencies; build a new-enough
# SQLite if the system one is too old. Safe to re-run.
# Agent tooling runs this once in every fresh worktree.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/_env.sh

[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.lock
.venv/bin/python -m pip install -q -e '.[dev]'

if ! sqlite_ok; then
  echo "setup: system SQLite too old, building $SQLITE_TARBALL into $SQLITE_PREFIX"
  build="$(mktemp -d)"
  trap 'rm -rf "$build"' EXIT
  curl -fsSL -o "$build/$SQLITE_TARBALL.tar.gz" "$SQLITE_URL"
  echo "$SQLITE_SHA256  $build/$SQLITE_TARBALL.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$build/$SQLITE_TARBALL.tar.gz" -C "$build"
  (cd "$build/$SQLITE_TARBALL" \
    && ./configure --prefix="$SQLITE_PREFIX" --disable-static --disable-readline >/dev/null \
    && make -j2 >/dev/null 2>&1 && make install >/dev/null 2>&1)
  . scripts/_env.sh
  sqlite_ok || { echo "setup: SQLite build did not take effect" >&2; exit 1; }
fi

if command -v npm >/dev/null; then
  echo "setup: installing website dependencies (web/)"
  (cd web && npm ci --no-audit --no-fund --silent)
else
  echo "setup: npm not found; the admin website needs Node 20+ (web/) to build" >&2
fi

echo "setup: ok ($(.venv/bin/python --version), SQLite $(.venv/bin/python -c 'import sqlite3; print(sqlite3.sqlite_version)'))"
