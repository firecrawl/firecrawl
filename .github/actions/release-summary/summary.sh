#!/usr/bin/env bash
# Needs a checkout with full history and a token with contents, actions and
# pull-requests read. Never fails the job: a release must not wait on this.
set -uo pipefail

repo="$GITHUB_REPOSITORY"
sha="$GITHUB_SHA"
web="$GITHUB_SERVER_URL/$repo"
workflow_file="${GITHUB_WORKFLOW_REF%@*}"
workflow_file="${workflow_file##*/}"
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
max_commits=100
PATHS="${PATHS:-}"
PUBLISHED_STEP="${PUBLISHED_STEP:-}"
PUBLISHES="${PUBLISHES:-}"

cell() { printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'; }

prev=""
prev_run=""
while read -r id run_sha; do
  [ -n "$id" ] || continue
  git merge-base --is-ancestor "$run_sha" "$sha" 2>/dev/null || continue
  approved=$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
    jq --arg n "$GATED_JOB" --arg s "$PUBLISHED_STEP" '[.jobs[]
      | select((.name == $n or (.name | startswith($n + " ("))) and .conclusion == "success")
      | select($s == "" or any(.steps[]?; .name == $s and .conclusion == "success"))] | length')
  if [ "${approved:-0}" -gt 0 ]; then
    prev="$run_sha"
    prev_run="$id"
    break
  fi
done < <(gh api "repos/$repo/actions/workflows/$workflow_file/runs?branch=$GITHUB_REF_NAME&status=completed&per_page=100" |
  jq -r --argjson n "$GITHUB_RUN_NUMBER" '.workflow_runs[] | select(.run_number < $n) | "\(.id) \(.head_sha)"')

subject=$(git log -1 --format=%s "$sha" 2>/dev/null)

{
  echo "## Release summary"
  echo
  if [ "$PUBLISHES" = false ]; then
    echo "Nothing new to publish: \`$(cell "$VERSION")\` is already released. Approving **$GATED_JOB** runs it without publishing."
  else
    echo "Approving **$GATED_JOB** publishes the version below from this commit."
  fi
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Version | \`$(cell "$VERSION")\` |"
  echo "| Commit | [\`${sha:0:10}\`]($web/commit/$sha) $(cell "$subject") |"
  if [ -n "$prev" ]; then
    tags=""
    for t in $(git tag --points-at "$prev"); do
      in_scope=${PATHS:+no}
      for p in $PATHS; do
        case "$t" in "${p%/}"/*) in_scope="" ;; esac
      done
      [ -z "$in_scope" ] && tags="${tags:+$tags, }$t"
    done
    echo "| Previously released | [\`${prev:0:10}\`]($web/commit/$prev)${tags:+ (tag $tags)}, released in [run $prev_run]($web/actions/runs/$prev_run) |"
    echo "| Compare | [${prev:0:10}...${sha:0:10}]($web/compare/$prev...$sha) |"
  else
    echo "| Previously released | none found in the last 100 completed runs of $workflow_file on $GITHUB_REF_NAME |"
  fi
  echo
} >> "$out"

[ -n "$prev" ] || exit 0

# shellcheck disable=SC2086
mapfile -t commits < <(git log --format=%H "$prev..$sha" -- $PATHS)
scope=""
[ -n "$PATHS" ] && scope=" touching \`$PATHS\`"

declare -A seen=()
pr_rows=()
direct=()
for c in "${commits[@]:0:$max_commits}"; do
  prs=$(gh api "repos/$repo/commits/$c/pulls" |
    jq -r '.[] | select(.merged_at != null) | [.number, .user.login, .title] | @tsv')
  if [ -z "$prs" ]; then
    direct+=("- [\`${c:0:10}\`]($web/commit/$c) $(git log -1 --format='%s (%an)' "$c")")
    continue
  fi
  while IFS=$'\t' read -r number author title; do
    [ -n "${seen[$number]:-}" ] && continue
    seen[$number]=1
    approvers=$(gh api "repos/$repo/pulls/$number/reviews?per_page=100" |
      jq -r '[.[] | select(.state == "APPROVED") | .user.login] | unique | join(", ")')
    pr_rows+=("| [#$number]($web/pull/$number) | $(cell "$title") | $author | ${approvers:-**none**} |")
  done <<< "$prs"
done

{
  echo "### Merged pull requests$scope (${#pr_rows[@]})"
  echo
  if [ "${#pr_rows[@]}" -gt 0 ]; then
    echo "| PR | Title | Author | Approved by |"
    echo "|---|---|---|---|"
    printf '%s\n' "${pr_rows[@]}"
  else
    echo "None."
  fi
  echo
  if [ "${#direct[@]}" -gt 0 ]; then
    echo "### Commits without a pull request (${#direct[@]})"
    echo
    printf '%s\n' "${direct[@]}"
    echo
  fi
  if [ "${#commits[@]}" -gt "$max_commits" ]; then
    echo "Only the newest $max_commits of ${#commits[@]} commits are listed. The compare link has the rest."
  fi
} >> "$out"
exit 0
