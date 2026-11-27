#!/usr/bin/env bash
# Needs actions write and contents read. Only a run whose status is "waiting"
# (held at an environment approval) is cancelled; a job that has started is never touched.
set -uo pipefail

repo="$GITHUB_REPOSITORY"
web="$GITHUB_SERVER_URL/$repo"
workflow_file="${GITHUB_WORKFLOW_REF%@*}"
workflow_file="${workflow_file##*/}"
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

while read -r id sha; do
  [ -n "$id" ] || continue
  relation=$(gh api "repos/$repo/compare/$sha...$GITHUB_SHA" --jq .status)
  case "$relation" in
    ahead | identical) ;;
    *) echo "Run $id on $sha is not included in $GITHUB_SHA ($relation); left waiting"; continue ;;
  esac
  state=$(gh api "repos/$repo/actions/runs/$id" --jq .status)
  if [ "$state" != waiting ]; then
    echo "Run $id is $state now; left alone"
    continue
  fi
  if gh run cancel "$id" -R "$repo"; then
    echo "- Cancelled [run $id]($web/actions/runs/$id), which was waiting for approval on \`${sha:0:10}\`. This run includes that commit." >> "$out"
  fi
done < <(gh api "repos/$repo/actions/workflows/$workflow_file/runs?branch=$GITHUB_REF_NAME&status=waiting&per_page=100" |
  jq -r --argjson n "$GITHUB_RUN_NUMBER" '.workflow_runs[] | select(.run_number < $n) | "\(.id) \(.head_sha)"')
exit 0
