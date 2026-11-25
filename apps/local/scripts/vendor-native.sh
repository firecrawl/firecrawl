#!/usr/bin/env bash
# Copy the shared pure-Rust modules from apps/api/native/crates into src/native
# and replace the unpublished workspace path dependencies in Cargo.toml with
# their crates.io dependencies so `cargo package` / `cargo publish` produces a
# self-contained crate.
#
# This mutates Cargo.toml, Cargo.lock, and src/native in place for the follow-on
# packaging steps in CI; after a local run, restore with:
#   rm -rf src/native && git checkout -- Cargo.toml Cargo.lock
set -euo pipefail

cd "$(dirname "$0")/.."
crates="../api/native/crates"
workspace_manifest="../api/native/Cargo.toml"

rm -rf src/native
mkdir -p src/native/markdown

cp "$crates/firecrawl-crawler/src/xml.rs" "src/native/xml.rs"
cp "$crates/firecrawl-html/src/html.rs" "src/native/html.rs"
cp "$crates/firecrawl-crawler/src/crawler.rs" "src/native/crawler.rs"
cp "$crates/firecrawl-parsers/src/document.rs" "src/native/document.rs"
cp "$crates/firecrawl-markdown/src/"*.rs "src/native/markdown/"
mv "src/native/markdown/lib.rs" "src/native/markdown/mod.rs"

expected=$(sed -nE 's/.*#\[path = "native\/([^"]+)"\].*/\1/p' src/lib.rs | sort)
if [ -z "$expected" ]; then
  echo "vendor-native: no #[path = \"native/...\"] entries found in src/lib.rs" >&2
  exit 1
fi
for rel in $expected; do
  if [ ! -f "src/native/$rel" ]; then
    echo "vendor-native: missing expected vendored file src/native/$rel" >&2
    exit 1
  fi
done

expected_top=$(printf '%s\n' "$expected" | sed 's|/.*||' | sort -u)
actual_top=$(ls -1 src/native | sort)
if [ "$expected_top" != "$actual_top" ]; then
  echo "vendor-native: copied entries do not match #[path = \"native/...\"] entries in src/lib.rs" >&2
  echo "expected: $expected_top" >&2
  echo "actual: $actual_top" >&2
  exit 1
fi

expected_md=$(ls -1 "$crates/firecrawl-markdown/src" | sed 's/^lib\.rs$/mod.rs/' | sort)
actual_md=$(ls -1 src/native/markdown | sort)
if [ "$expected_md" != "$actual_md" ]; then
  echo "vendor-native: vendored markdown modules do not match firecrawl-markdown/src" >&2
  exit 1
fi

echo "vendored $(printf '%s\n' "$expected" | paste -sd, - | sed 's/,/, /g')"

extract_ver() {
  sed -nE "s/^$1 = \"([^\"]+)\".*/\\1/p; s/^$1 = \\{[^}]*version = \"([^\"]+)\".*/\\1/p" "$workspace_manifest" | head -1
}

nodesig_ver=$(extract_ver nodesig)
roxmltree_ver=$(extract_ver roxmltree)
if [ -z "$nodesig_ver" ] || [ -z "$roxmltree_ver" ]; then
  echo "vendor-native: failed to read nodesig/roxmltree versions from $workspace_manifest" >&2
  exit 1
fi

start_marker='^# --- shared workspace crates'
end_marker='^# --- end shared workspace crates ---$'
has_start=0
has_end=0
has_path_deps=0
grep -qE "$start_marker" Cargo.toml && has_start=1
grep -qE "$end_marker" Cargo.toml && has_end=1
grep -q 'path = "../api/native/crates/' Cargo.toml && has_path_deps=1

if [ "$has_start" -eq 1 ] || [ "$has_end" -eq 1 ] || [ "$has_path_deps" -eq 1 ]; then
  if [ "$has_start" -ne 1 ] || [ "$has_end" -ne 1 ]; then
    echo "vendor-native: missing or unbalanced shared workspace crates markers in Cargo.toml" >&2
    exit 1
  fi
  if ! awk -v nodesig_ver="$nodesig_ver" -v roxmltree_ver="$roxmltree_ver" '
    /^# --- shared workspace crates/ {
      if (in_block || replaced) { exit 2 }
      print "nodesig = \"" nodesig_ver "\""
      print "roxmltree = \"" roxmltree_ver "\""
      in_block = 1
      next
    }
    /^# --- end shared workspace crates ---$/ {
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
    echo "vendor-native: invalid shared workspace crates marker block in Cargo.toml" >&2
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
