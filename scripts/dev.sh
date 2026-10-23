#!/usr/bin/env bash
# Run the admin website locally for previewing changes, against a throwaway
# data directory inside the checkout (data/ is gitignored). Never point this
# at real data.
#
# Serves the last `npm run build` from web/ (run `cd web && npm run build`, or
# scripts/check.sh). For live reload while editing the website, also run
# `cd web && npm run dev` and open http://127.0.0.1:5190 (it proxies /v1 here).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/_env.sh

export AVN_DATA_DIR="${AVN_DATA_DIR:-$PWD/data}"
export AVN_ADMIN_TOKEN="${AVN_ADMIN_TOKEN:-local-dev-token-not-a-secret-0123456789}"
export AVN_NUTBOT="${AVN_NUTBOT:-false}"
mkdir -p "$AVN_DATA_DIR"
[ -f avn_analytics/static/index.html ] || { echo "dev: no website build; run 'cd web && npm run build' first" >&2; exit 2; }

exec .venv/bin/uvicorn avn_analytics.api:create_admin_app --factory \
  --host 127.0.0.1 --port "${PORT:-8201}"
