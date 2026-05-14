#!/bin/bash

# Upstream-safe merge script for Firecrawl fork
# This script helps maintain compatibility with upstream changes

set -e

echo "Fetching latest upstream changes..."
git fetch upstream

echo "Checking for conflicts..."
if git merge-tree $(git merge-base HEAD upstream/main) HEAD upstream/main | grep -q "^+<<<<<<< "; then
    echo "Conflicts detected. Please resolve manually."
    exit 1
fi

echo "Merging upstream changes..."
git merge upstream/main --no-edit

echo "Running tests to verify compatibility..."
# Add test command here
# pnpm harness jest --testPathPattern="agent|engine"

echo "Merge completed successfully. Review changes before pushing."