#!/usr/bin/env bash
# Demo only: put paymas-checkout main back to the last good commit,
# then close extra PRs/issues and remove extra incident records.
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DEMO_DIR/.." && pwd)"
STATE="$DEMO_DIR/.last-good"

if [[ -f "$STATE" ]]; then
  GOOD="$(cat "$STATE")"
  cd "$DEMO_DIR/../../paymas-checkout"

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "paymas-checkout has uncommitted changes; commit or stash them first"; exit 1
  fi

  git checkout -q main
  git fetch -q origin
  git reset -q --hard "$GOOD"
  git push -q --force-with-lease origin main
  rm -f "$STATE"
  echo "reset paymas-checkout main to ${GOOD:0:7}; restart the paymas server"
else
  echo "no .last-good; skipping checkout reset"
fi

cd "$ROOT"
"$ROOT/node_modules/.bin/tsx" src/incidents/cleanup.ts
