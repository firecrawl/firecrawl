#!/usr/bin/env bash
# Stage a self-contained crate for publishing. Run in a disposable checkout:
# this rewrites Cargo.toml, Cargo.lock, and src/native in place.
set -euo pipefail

cd "$(dirname "$0")/.."
core_src="../api/native/crates/firecrawl-core/src"
workspace_manifest="../api/native/Cargo.toml"

rm -rf src/native
mkdir -p src/native

cp "$core_src/xml.rs" "$core_src/html.rs" "$core_src/crawler.rs" "$core_src/parsers/document.rs" src/native/

expected=$(sed -nE 's/.*#\[path = "native\/([^"]+)"\].*/\1/p' src/lib.rs | sort)
actual=$(ls -1 src/native | sort)
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "vendor-native: copied files do not match #[path = \"native/...\"] entries in src/lib.rs" >&2
  echo "expected: $expected" >&2
  echo "actual: $actual" >&2
  exit 1
fi

echo "vendored $(printf '%s\n' "$actual" | paste -sd, - | sed 's/,/, /g')"

extract_ver() {
  sed -nE "s/^$1 = \"([^\"]+)\".*/\\1/p; s/^$1 = \\{[^}]*version = \"([^\"]+)\".*/\\1/p" "$workspace_manifest" | head -1
}

nodesig_ver=$(extract_ver nodesig)
roxmltree_ver=$(extract_ver roxmltree)
if [ -z "$nodesig_ver" ] || [ -z "$roxmltree_ver" ]; then
  echo "vendor-native: failed to read nodesig/roxmltree versions from $workspace_manifest" >&2
  exit 1
fi

start_marker='^# --- shared workspace crate '
end_marker='^# --- end shared workspace crate ---$'
has_start=0
has_end=0
has_path_deps=0
grep -qE "$start_marker" Cargo.toml && has_start=1
grep -qE "$end_marker" Cargo.toml && has_end=1
grep -q 'path = "../api/native/crates/' Cargo.toml && has_path_deps=1

if [ "$has_start" -eq 1 ] || [ "$has_end" -eq 1 ] || [ "$has_path_deps" -eq 1 ]; then
  if [ "$has_start" -ne 1 ] || [ "$has_end" -ne 1 ]; then
    echo "vendor-native: missing or unbalanced shared workspace crate markers in Cargo.toml" >&2
    exit 1
  fi
  if ! awk -v nodesig_ver="$nodesig_ver" -v roxmltree_ver="$roxmltree_ver" '
    /^# --- shared workspace crate / {
      if (in_block || replaced) { exit 2 }
      print "nodesig = \"" nodesig_ver "\""
      print "roxmltree = \"" roxmltree_ver "\""
      in_block = 1
      next
    }
    /^# --- end shared workspace crate ---$/ {
      if (!in_block) { exit 3 }
      in_block = 0
      replaced = 1
      next
    }
    !in_block { print }
    END {
      if (in_block || !replaced) { exit 4 }
    }
  ' Cargo.toml > Cargo.toml.tmp; then
    rm -f Cargo.toml.tmp
    echo "vendor-native: invalid shared workspace crate marker block in Cargo.toml" >&2
    exit 1
  fi
  mv Cargo.toml.tmp Cargo.toml
fi

if grep -q 'path = "../api/native/crates/' Cargo.toml; then
  echo "vendor-native: workspace path dependencies still remain in Cargo.toml" >&2
  exit 1
fi

# Refresh Cargo.lock so it drops the removed path-dependency entries and keeps
# the already-locked crates.io versions of nodesig and roxmltree.
cargo metadata --format-version=1 >/dev/null
