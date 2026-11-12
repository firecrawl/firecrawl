#!/usr/bin/env bash
# Copy the shared cleaning code from apps/api/native/src into src/native, so a
# packaged crate carries it. Run before `cargo package` or `cargo publish`.
# The list of files is read from src/lib.rs, so it cannot drift.
set -euo pipefail

cd "$(dirname "$0")/.."
shared="../api/native/src"
files=$(sed -nE 's/.*path = "\.\.\/\.\.\/api\/native\/src\/([a-z_]+\.rs)".*/\1/p' src/lib.rs | sort -u)
if [ -z "$files" ]; then
  echo "vendor-native: found no shared files listed in src/lib.rs" >&2
  exit 1
fi

rm -rf src/native
mkdir -p src/native
for file in $files; do
  cp "$shared/$file" "src/native/$file"
  echo "vendored $file"
done
