#!/bin/bash
set -e

# Get release version from environment variables or git
RELEASE="${SENTRY_RELEASE:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'unknown')}}"

# Directory containing sourcemaps
DIST_DIR="${1:-./dist}"

echo "Uploading Sentry sourcemaps..."
echo "Release: $RELEASE"
echo "Directory: $DIST_DIR"

# Inject sourcemaps (org/project from env vars or .sentryclirc)
sentry-cli sourcemaps inject "$DIST_DIR"

# Upload sourcemaps (org/project from env vars or .sentryclirc)
sentry-cli sourcemaps upload \
  --release "$RELEASE" \
  "$DIST_DIR"

echo "Sentry sourcemaps uploaded successfully!"

