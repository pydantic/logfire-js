#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

mapfile -t files < <(
  {
    git diff --name-only --diff-filter=ACMR
    git diff --cached --name-only --diff-filter=ACMR
    git ls-files --others --exclude-standard
  } |
    awk '
      /\.(js|ts|tsx|mjs|mts|json|md|ya?ml)$/ {
        if ($0 ~ /^(packages|examples|docs|\.changeset)\// || $0 ~ /^\.codex\/hooks\.json$/ || $0 ~ /^(package\.json|pnpm-workspace\.yaml|vite\.config\.ts|README\.md|AGENTS\.md)$/) {
          print
        }
      }
    ' |
    sort -u
)

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

vp check --fix "${files[@]}"
