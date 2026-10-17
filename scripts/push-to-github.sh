#!/usr/bin/env bash
# Push SwarmOS to GitHub. Usage:
#   ./scripts/push-to-github.sh <remote-url> [token]
# Examples:
#   ./scripts/push-to-github.sh https://github.com/you/swarmos.git
#   ./scripts/push-to-github.sh https://github.com/you/swarmos.git ghp_xxxxxxxx
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${1:?Usage: push-to-github.sh <remote-url> [token]}"
TOKEN="${2:-}"

if [ -n "$TOKEN" ]; then
  # embed token for this push only (HTTPS basic auth)
  case "$REMOTE" in
    https://*) REMOTE="https://x-access-token:${TOKEN}@${REMOTE#https://}" ;;
  esac
fi

git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"
git push -u origin main
echo "✅ Pushed to $REMOTE"
