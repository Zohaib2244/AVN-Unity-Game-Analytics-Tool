#!/usr/bin/env bash
# Cut a release: run the gate, tag main, push main + tag to GitHub.
#
#   scripts/release.sh            next patch version (v0.1.0 if there are no tags yet)
#   scripts/release.sh minor      next minor;  `major` likewise
#   scripts/release.sh v1.2.3     an explicit version
#
# Does NOT deploy; follow with scripts/deploy.sh (the T3 "Deploy" action does both).
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }

[ "$(git branch --show-current)" = main ] || die "releases are cut from main (you are on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first"
git fetch --quiet --tags origin
[ -z "$(git rev-list HEAD..origin/main)" ] || die "origin/main has commits you don't have; pull first"

last=$(git tag -l 'v*' --sort=-v:refname | head -1)
if [ -n "$last" ] && [ "$(git rev-parse HEAD)" = "$(git rev-list -n1 "$last")" ]; then
  echo "release: HEAD is already $last, nothing new to tag"
  exit 0
fi

scripts/check.sh

last=$(git tag -l 'v*' --sort=-v:refname | head -1)
bump=${1:-patch}
case "$bump" in
  v[0-9]*) next=$bump ;;
  patch|minor|major)
    if [ -z "$last" ]; then next=v0.1.0; else
      IFS=. read -r ma mi pa <<< "${last#v}"
      case "$bump" in
        major) next="v$((ma + 1)).0.0" ;;
        minor) next="v$ma.$((mi + 1)).0" ;;
        patch) next="v$ma.$mi.$((pa + 1))" ;;
      esac
    fi ;;
  *) die "unknown version argument: $bump" ;;
esac
git rev-parse -q --verify "refs/tags/$next" > /dev/null && die "$next already exists"

echo; echo "release $next  (previous: ${last:-none})"
git log --oneline "${last:+$last..}HEAD" | head -30
echo
[ -t 0 ] || die "needs a terminal to confirm"
read -r -p "Tag $next and push main + tag to origin? [y/N] " answer
[ "$answer" = y ] || [ "$answer" = Y ] || die "cancelled, nothing changed"

git tag -a "$next" -m "AVN Analytics $next"
git push origin main "$next"
echo "released $next"
