#!/usr/bin/env bash
# Copy the shared pure-Rust modules from apps/api/native/crates into src/native
# and replace the unpublished workspace path dependencies in Cargo.toml with
# their crates.io dependencies so `cargo package` / `cargo publish` produces a
# self-contained crate.
set -euo pipefail

cd "$(dirname "$0")/.."
crates="../api/native/crates"
workspace_manifest="../api/native/Cargo.toml"

rm -rf src/native
mkdir -p src/native

cp "$crates/firecrawl-crawler/src/xml.rs" "src/native/xml.rs"
cp "$crates/firecrawl-html/src/html.rs" "src/native/html.rs"
cp "$crates/firecrawl-crawler/src/crawler.rs" "src/native/crawler.rs"
cp "$crates/firecrawl-parsers/src/document.rs" "src/native/document.rs"

echo "vendored xml.rs, html.rs, crawler.rs, document.rs"

extract_ver() {
  sed -nE "s/^$1 = \"([^\"]+)\".*/\\1/p; s/^$1 = \\{[^}]*version = \"([^\"]+)\".*/\\1/p" "$workspace_manifest" | head -1
}

nodesig_ver=$(extract_ver nodesig)
roxmltree_ver=$(extract_ver roxmltree)
if [ -z "$nodesig_ver" ] || [ -z "$roxmltree_ver" ]; then
  echo "vendor-native: failed to read nodesig/roxmltree versions from $workspace_manifest" >&2
  exit 1
fi

if grep -q '# --- shared workspace crates' Cargo.toml; then
  awk -v nodesig_ver="$nodesig_ver" -v roxmltree_ver="$roxmltree_ver" '
    /^# --- shared workspace crates/ {
      print "nodesig = \"" nodesig_ver "\""
      print "roxmltree = \"" roxmltree_ver "\""
      skip = 1
      next
    }
    /^# --- end shared workspace crates ---$/ {
      skip = 0
      next
    }
    !skip { print }
  ' Cargo.toml > Cargo.toml.tmp
  mv Cargo.toml.tmp Cargo.toml
fi

# Refresh Cargo.lock so it drops the removed path-dependency entries and keeps
# the already-locked crates.io versions of nodesig and roxmltree.
cargo metadata --format-version=1 >/dev/null
