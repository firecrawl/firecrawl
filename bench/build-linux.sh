#!/bin/bash
# Builds the engine for Linux inside a Rust container and the small runtime
# image the benchmark runs it in. Output: apps/engine/target-linux/release.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/bench/.work/env.sh" ] && . "$ROOT/bench/.work/env.sh"
docker run --rm -v "$ROOT:/src" -w /src/apps/engine \
  -e CARGO_TARGET_DIR=/src/apps/engine/target-linux \
  -v fcengine-cargo:/usr/local/cargo/registry \
  rust:1-bookworm cargo build --release --locked
docker build -t fcengine-base:bench "$ROOT/bench/engine-image"
ls -la "$ROOT/apps/engine/target-linux/release/firecrawl-engine"
