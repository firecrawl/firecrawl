#!/bin/bash
# Builds the engine for Linux inside a Rust container and the small runtime
# image the benchmark runs it in. Output: apps/engine/target-linux/release.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/bench/.work/env.sh" ] && . "$ROOT/bench/.work/env.sh"
# Runs as the calling user so the build output is not left owned by root.
# Cargo's download cache goes in the git-ignored bench/.work for the same reason.
mkdir -p "$ROOT/bench/.work/cargo-home"
docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/src" -w /src/apps/engine \
  -e CARGO_TARGET_DIR=/src/apps/engine/target-linux \
  -e CARGO_HOME=/src/bench/.work/cargo-home \
  rust:1-bookworm cargo build --release --locked
docker build -t fcengine-base:bench "$ROOT/bench/engine-image"
ls -la "$ROOT/apps/engine/target-linux/release/firecrawl-engine"
