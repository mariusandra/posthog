#!/usr/bin/env bash
set -euo pipefail

desktop_base=${1:?Pass the pre-merge desktop commit}

# A restore alone cannot remove unmerged paths absent from the source commit.
git rm -r -f --ignore-unmatch -- .github/workflows products/desktop
git restore --source="$desktop_base" --staged --worktree -- .github/workflows products/desktop
