#!/usr/bin/env bash
# Decides whether a pull request from <source> may target <target> (simplified GitFlow).
# Exits 0 when allowed. Otherwise prints the reason to stderr and exits 1.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: branch-policy.sh <source> <target>" >&2
  exit 2
fi

source_branch="$1"
target_branch="$2"

case "$target_branch" in
  main)
    case "$source_branch" in
      develop | hotfix/* | release-please--*) exit 0 ;;
    esac
    reason="A pull request into \"main\" must come from \"develop\", a \"hotfix/*\" or a \"release-please--*\" branch, not from \"$source_branch\"."
    ;;
  develop)
    case "$source_branch" in
      feature/* | bugfix/* | hotfix/* | dependabot/* | sync/*) exit 0 ;;
    esac
    reason="A pull request into \"develop\" must come from a \"feature/*\", \"bugfix/*\", \"hotfix/*\", \"dependabot/*\" or \"sync/*\" branch, not from \"$source_branch\"."
    ;;
  *)
    reason="A pull request from \"$source_branch\" must target \"develop\" or \"main\", not \"$target_branch\"."
    ;;
esac

echo "branch-policy: $reason" >&2
exit 1
