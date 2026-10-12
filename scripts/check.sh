#!/usr/bin/env bash
# The single "is this change good?" gate: lint, format check, tests.
# Exit code 0 means ready for review.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/_env.sh

[ -x .venv/bin/python ] || { echo "check: no .venv, run scripts/setup.sh first" >&2; exit 2; }

echo "== ruff check";  .venv/bin/ruff check .
echo "== ruff format"; .venv/bin/ruff format --check .
echo "== pytest";      .venv/bin/python -m pytest -q
echo "check: all passed"
