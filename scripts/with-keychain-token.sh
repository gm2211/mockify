#!/usr/bin/env bash
# Runs a command with CLAUDE_CODE_OAUTH_TOKEN sourced from the macOS keychain.
# The token never touches disk, argv, or stdout — it flows keychain -> env -> child process.
#
# Usage: with-keychain-token.sh <keychain-service-name> <command> [args...]
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") <keychain-service-name> <command> [args...]" >&2
  exit 2
fi

service="$1"
shift

# Pin the lookup to the login keychain. Without an explicit keychain, `security`
# searches the default list — which includes /Library/Keychains/System.keychain —
# and touching that raises a modal admin-password prompt.
CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s "$service" -w "$HOME/Library/Keychains/login.keychain-db")"
export CLAUDE_CODE_OAUTH_TOKEN

exec "$@"
