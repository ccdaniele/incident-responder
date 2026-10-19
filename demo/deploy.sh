#!/usr/bin/env bash
# Demo only: "deploy" a seeded bug to paymas-checkout main on GitHub.
set -euo pipefail

case "${1:-}" in
  a) BRANCH="change/installments-refactor" ;;
  b) BRANCH="change/due-date-helper" ;;
  *) echo "usage: npm run demo:deploy -- a|b"; exit 1 ;;
esac

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$DEMO_DIR/.last-good"
cd "$DEMO_DIR/../../paymas-checkout"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "paymas-checkout has uncommitted changes; commit or stash them first"; exit 1
fi

git checkout -q main
git pull -q --ff-only origin main
[[ -f "$STATE" ]] || git rev-parse HEAD > "$STATE"

git fetch -q origin "$BRANCH"
git cherry-pick "origin/$BRANCH"
git push -q origin main

echo "deployed incident ${1} as $(git rev-parse --short HEAD) (last good: $(cut -c1-7 "$STATE"))"
echo "next: restart the paymas server, then start traffic"