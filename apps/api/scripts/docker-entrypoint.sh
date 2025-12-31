#!/bin/bash
set -e

# Read commit SHA from file if SENTRY_RELEASE is not already set
if [ -z "$SENTRY_RELEASE" ] && [ -f /tmp/commit_sha.txt ]; then
  export SENTRY_RELEASE=$(cat /tmp/commit_sha.txt)
  echo "Set SENTRY_RELEASE=$SENTRY_RELEASE from commit SHA file"
fi

# Execute the main command
exec "$@"
