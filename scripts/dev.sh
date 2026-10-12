#!/usr/bin/env bash
# Run the admin website locally for previewing changes, against a throwaway
# data directory inside the checkout (data/ is gitignored). Never point this
# at real data.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/_env.sh

export AVN_DATA_DIR="${AVN_DATA_DIR:-$PWD/data}"
export AVN_ADMIN_TOKEN="${AVN_ADMIN_TOKEN:-local-dev-token-not-a-secret-0123456789}"
export AVN_NUTBOT="${AVN_NUTBOT:-false}"
mkdir -p "$AVN_DATA_DIR"

exec .venv/bin/uvicorn avn_analytics.api:create_admin_app --factory \
  --host 127.0.0.1 --port "${PORT:-8201}"
