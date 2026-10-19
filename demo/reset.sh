#!/usr/bin/env bash
# Demo only: put paymas-checkout main back to the last good commit, close demo PRs/issues.
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$DEMO_DIR/.last-good"
[[ -f "$STATE" ]] || { echo "nothing to reset"; exit 0; }
GOOD="$(cat "$STATE")"
cd "$DEMO_DIR/../../paymas-checkout"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "paymas-checkout has uncommitted changes; commit or stash them first"; exit 1
fi

git checkout -q main
git fetch -q origin
git reset -q --hard "$GOOD"
git push -q --force-with-lease origin main

for n in $(gh pr list --state open --json number --jq '.[].number'); do
  gh pr close "$n" --delete-branch
done
for n in $(gh issue list --state open --label incident --json number --jq '.[].number' 2>/dev/null || true); do
  gh issue close "$n"
done

rm -f "$STATE"
echo "reset paymas-checkout main to ${GOOD:0:7}; restart the paymas server"