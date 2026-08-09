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

CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s "$service" -w)"
export CLAUDE_CODE_OAUTH_TOKEN

exec "$@"
