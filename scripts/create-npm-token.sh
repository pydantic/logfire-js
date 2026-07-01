#!/usr/bin/env bash
set -euo pipefail

# Creates a granular npm token for CI publishing and updates the
# NPM_TOKEN secret in the GitHub repo.
# Covers both @pydantic scoped packages and the unscoped "logfire" package.
# 90-day expiry, bypasses 2FA for CI. Requires gh CLI.
# Assumes you are already logged in to npm (run `npm login` first if needed).
#
# Runs from a temp directory to avoid project .npmrc / devEngines config.

REPO="pydantic/logfire-js"
ENVIRONMENT="npm"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
TOKEN_FILE="$WORKDIR/token.txt"

command -v gh >/dev/null || { echo "gh CLI is required."; exit 1; }
command -v npm >/dev/null || { echo "npm CLI is required."; exit 1; }
command -v script >/dev/null || { echo "script command is required to preserve interactive npm prompts."; exit 1; }

echo "Checking GitHub authentication..."
gh auth status --hostname github.com >/dev/null

echo "Checking npm authentication..."
npm whoami --registry https://registry.npmjs.org/ >/dev/null

echo "Creating npm granular access token..."
echo ""

# Use `script` to preserve TTY so npm can prompt for OTP interactively
script -q "$TOKEN_FILE" sh -c "cd '$WORKDIR' && npm token create \
  --name 'logfire-js CI publish $(date +%Y-%m-%d)' \
  --expires 90 \
  --scopes @pydantic \
  --packages logfire \
  --packages-and-scopes-permission read-write \
  --bypass-2fa"

echo ""

TOKEN=$(
  awk -F '│' '
    tolower($2) ~ /^[[:space:]]*token[[:space:]]*$/ {
      value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$TOKEN_FILE" | tr -d '\r'
)

if [ -z "$TOKEN" ]; then
  TOKEN=$(grep -Eo 'npm_[A-Za-z0-9_=-]+' "$TOKEN_FILE" | head -1 || true)
fi

if [ -z "$TOKEN" ]; then
  echo "Failed to extract token from output."
  exit 1
fi

echo "Updating NPM_TOKEN secret in $REPO (environment: $ENVIRONMENT)..."
gh secret set NPM_TOKEN --repo "$REPO" --env "$ENVIRONMENT" --body "$TOKEN" >/dev/null

echo "Done. NPM_TOKEN secret updated in $REPO (environment: $ENVIRONMENT)."
