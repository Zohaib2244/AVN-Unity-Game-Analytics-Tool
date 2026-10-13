#!/usr/bin/env bash
# Deploy a tagged release of AVN Analytics on this server (avns2).
#
#   scripts/deploy.sh             deploy the newest v* tag
#   scripts/deploy.sh v0.2.0      deploy a specific tag
#   scripts/deploy.sh --status    show what is deployed and what is available
#   scripts/deploy.sh --rollback  go back to the previous release
#
# Layout (see ~/docs, "avns_apps"):
#   $AVNS_APPS_ROOT/avn-analytics/src      read-only git checkout, only ever checked out at tags
#   $AVNS_APPS_ROOT/avn-analytics/config   .env and compose.override.yaml (never in git)
# This script is run from the dev clone but acts on the deploy checkout above.
set -euo pipefail

# --yes skips the y/N prompts (for scripted use); the T3 action stays interactive.
YES=0; args=()
for a in "$@"; do if [ "$a" = --yes ]; then YES=1; else args+=("$a"); fi; done
set -- ${args[@]+"${args[@]}"}

APP=avn-analytics
IMAGE=avn-analytics:local
ROLLBACK_IMAGE=avn-analytics:rollback
ROOT=${AVNS_APPS_ROOT:-/opt/docker/avns_apps}/$APP
SRC=$ROOT/src
CFG=$ROOT/config
LOG=$ROOT/deploy.log
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-150}

die() { echo "deploy: $*" >&2; exit 1; }
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
dc() {
  docker compose -p "$APP" --project-directory "$SRC" \
    -f "$SRC/compose.yaml" -f "$CFG/compose.override.yaml" --env-file "$CFG/.env" "$@"
}
git_src() { git -C "$SRC" "$@"; }
confirm() { # confirm "question"
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "needs a terminal to confirm"
  read -r -p "$1 [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die "cancelled, nothing changed"
}

preflight() {
  [ -d "$SRC/.git" ] || die "no checkout at $SRC (see the avns_apps setup notes)"
  [ -f "$CFG/.env" ] || die "missing $CFG/.env"
  [ -f "$CFG/compose.override.yaml" ] || die "missing $CFG/compose.override.yaml"
  [ -z "$(git_src status --porcelain)" ] || die "$SRC has local edits; the deploy checkout is never edited. Commit them in the dev clone."
  git_src fetch --quiet --tags --prune origin
}

deployed_tag() { cat "$ROOT/.deployed" 2>/dev/null || echo "(none)"; }
latest_tag()   { git_src tag -l 'v*' --sort=-v:refname | head -1; }

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) ids id state bad
  echo "waiting for containers to be healthy (up to ${HEALTH_TIMEOUT}s)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    ids=$(dc ps -q)
    [ -n "$ids" ] || { sleep 3; continue; }
    bad=0
    for id in $ids; do
      state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
      case "$state" in
        healthy|running) ;;
        unhealthy|exited|dead) return 1 ;;
        *) bad=1 ;;
      esac
    done
    [ "$bad" -eq 0 ] && return 0
    sleep 3
  done
  return 1
}

roll_back_to() { # roll_back_to <tag>
  local tag=$1
  echo "rolling back to $tag"
  git_src checkout --quiet --detach "$tag"
  if docker image inspect "$ROLLBACK_IMAGE" > /dev/null 2>&1; then
    docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    dc up -d --no-build --force-recreate --remove-orphans
  else
    dc build && dc up -d --force-recreate --remove-orphans
  fi
  if wait_healthy; then
    echo "$tag" > "$ROOT/.deployed"; log "ROLLED BACK to $tag"; echo "rolled back to $tag, healthy"
  else
    log "ROLLBACK to $tag FAILED"; die "rollback to $tag did not become healthy, check: docker compose -p $APP logs"
  fi
}

ship() { # ship <tag>
  local target=$1 current prev_for_rollback
  current=$(deployed_tag)
  git_src rev-parse -q --verify "refs/tags/$target" > /dev/null || die "no tag $target on origin"
  echo "deployed now : $current"
  echo "deploying    : $target"
  if [ "$current" != "(none)" ] && git_src rev-parse -q --verify "refs/tags/$current" > /dev/null; then
    echo; git_src log --oneline "$current..$target" | head -30
    echo; git_src diff --stat "$current" "$target" | tail -15
    git_src diff --quiet "$current" "$target" -- compose.yaml Dockerfile || echo "NOTE: compose.yaml or Dockerfile changed in this release"
  fi
  echo
  confirm "Deploy $target to the live server now?"
  prev_for_rollback=$current
  docker image inspect "$IMAGE" > /dev/null 2>&1 && docker tag "$IMAGE" "$ROLLBACK_IMAGE"
  log "DEPLOY $current -> $target"
  git_src checkout --quiet --detach "$target"
  dc build
  dc up -d --remove-orphans
  if wait_healthy; then
    echo "$current" > "$ROOT/.previous"; echo "$target" > "$ROOT/.deployed"
    log "OK $target healthy"; echo "deployed $target, healthy"
  else
    echo "!! $target did not become healthy; last log lines:" >&2
    dc logs --tail 20 >&2 || true
    log "FAILED $target, rolling back"
    if [ "$prev_for_rollback" = "(none)" ]; then die "first deploy failed; nothing to roll back to"; fi
    roll_back_to "$prev_for_rollback"
    exit 1
  fi
}

case "${1:-}" in
  --status)
    [ -d "$SRC/.git" ] || die "no checkout at $SRC"
    git_src fetch --quiet --tags --prune origin
    echo "deployed : $(deployed_tag)"
    echo "latest   : $(latest_tag)"
    echo "previous : $(cat "$ROOT/.previous" 2>/dev/null || echo '(none)')"
    [ "$(deployed_tag)" = "$(latest_tag)" ] && echo "up to date" || echo "update available"
    ;;
  --rollback)
    preflight
    prev=$(cat "$ROOT/.previous" 2>/dev/null) || die "no previous release recorded"
    confirm "Roll back from $(deployed_tag) to $prev?"
    roll_back_to "$prev"
    ;;
  -h|--help) sed -n '2,12p' "$0" ;;
  *)
    preflight
    target=${1:-$(latest_tag)}
    [ -n "$target" ] || die "no v* tags yet; run scripts/release.sh first"
    ship "$target"
    ;;
esac
