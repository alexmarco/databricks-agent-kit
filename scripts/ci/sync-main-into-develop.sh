#!/usr/bin/env bash
# Prepares the back-merge of main into develop (simplified GitFlow, squash merges into develop).
# Pushes sync/main-into-develop (develop plus a merge of main) and prints "changed=true" when
# develop would change. Prints "changed=false" and pushes nothing when it would not, which is the
# case once a previous sync pull request was squash-merged. Exits 1 when the merge conflicts.
# Run it inside a clone whose "origin" has both branches. The caller opens the pull request.
set -euo pipefail

sync_branch="sync/main-into-develop"

git fetch --quiet origin main develop

develop_tree=$(git rev-parse "origin/develop^{tree}")
if ! merged_tree=$(git merge-tree --write-tree origin/develop origin/main); then
  echo "sync: merging main into develop has conflicts. Resolve them in a branch from develop." >&2
  exit 1
fi

if [ "$merged_tree" = "$develop_tree" ]; then
  echo "changed=false"
  exit 0
fi

git switch --quiet -C "$sync_branch" origin/develop
git merge --quiet --no-ff origin/main -m "chore: sync main back into develop"
git push --quiet --force origin "$sync_branch"
echo "changed=true"
