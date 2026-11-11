#!/bin/bash
# The "Start here" block for AI agents is repeated in every harness
# instruction file, because each harness reads a different one. This fails
# when the copies stop matching AGENTS.md.
set -eu
cd "$(dirname "$0")/../.."
block() { awk '/<!-- agent-routing:start -->/{on=1} on{print} /<!-- agent-routing:end -->/{on=0}' "$1"; }
want="$(block AGENTS.md)"
[ -n "$want" ] || { echo "AGENTS.md has no agent-routing block"; exit 1; }
status=0
for f in CLAUDE.md GEMINI.md .github/copilot-instructions.md .clinerules; do
  if [ "$(block "$f")" != "$want" ]; then
    echo "$f: the agent-routing block differs from AGENTS.md"
    status=1
  fi
done
exit $status
