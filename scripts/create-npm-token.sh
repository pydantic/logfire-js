#!/usr/bin/env bash
set -uo pipefail

# Creates a granular npm token for CI publishing and updates the
# NPM_TOKEN secret in the GitHub repo.
# Covers both @pydantic scoped packages and the unscoped "logfire" package.
# 90-day expiry, bypasses 2FA for CI. Requires gh CLI.
# Assumes you are already logged in to npm (run `npm login` first if needed).
#
# Runs from a temp directory to avoid project .npmrc / devEngines config.

REPO="pydantic/logfire-js"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
TOKEN_FILE="$WORKDIR/token.txt"

echo "Creating npm granular access token..."
echo ""

# Use `script` to preserve TTY so npm can prompt for OTP interactively
script -q "$TOKEN_FILE" sh -c "cd '$WORKDIR' && npm token create \
  --name 'logfire-js CI publish $(date +%Y-%m-%d)' \
  --expires 90 \
  --scopes @pydantic \
  --packages logfire \
  --packages-and-scopes-permission read-write \
  --bypass-2fa \
  --otp=''"

echo ""

TOKEN=$(grep -i 'token' "$TOKEN_FILE" | grep '│' | head -1 | sed 's/.*│[[:space:]]*//' | sed 's/[[:space:]]*$//' | tr -d '\r')

if [ -z "$TOKEN" ]; then
  echo "Failed to extract token from output."
  exit 1
fi

echo "Token:"
echo "$TOKEN"

# echo "Updating NPM_TOKEN secret in $REPO (environment: npm)..."
# echo "$TOKEN" | gh secret set NPM_TOKEN --repo "$REPO" --env npm
# echo "Done. NPM_TOKEN secret updated in $REPO."
