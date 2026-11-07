# Firecrawl Release & Changelog Automation

This file is the source of truth for the weekly Cursor cloud agent automation that drafts a Firecrawl release and changelog post. The dashboard prompt is intentionally short and tells the agent to read this file and follow it.

> **Repo context.** This automation runs in `firecrawl/firecrawl`. The drafts it generates are artifacts saved in this repo for review — they are **not** the final published content. Final publishing is manual and may cross repo boundaries (see "Publishing workflow" below).

---

## 1. Trigger & scope

- **Schedule.** Weekly cron `0 9 * * 4` (Thursdays 09:00 UTC).
- **Scope.** Aggregate every commit in `firecrawl/firecrawl` since the most recent published GitHub release tag.
- **Output.** Two markdown files under `release-drafts/v<NEW_VERSION>/`:
  - `github-release.md` — body for the GitHub release.
  - `changelog-post.mdx` — short post for the firecrawl.dev changelog.

---

## 2. Versioning

- The **next** version is determined by incrementing the **most recent published GitHub release tag** in `firecrawl/firecrawl`. Check via `gh release list --limit 1` or `git tag --sort=-v:refname | head -1`.
- **Always bump the major version when the previous minor is `9`.** Example: `v2.9.0` → `v3.0.0` (NOT `v2.10.0`).
- Otherwise bump the minor: `vX.Y.0` → `vX.(Y+1).0`.
- Patch versions are not used for these scheduled releases.
- Never hardcode the version. Always re-check the latest tag at the start of every run.

---

## 3. Changelog post date

- The date in the changelog post frontmatter and `## v<NEW_VERSION> is live` heading must be **the day AFTER the automation run date** (run date + 1 day).
- Format: `Month D, YYYY` (e.g. `May 16, 2026`).
- Example: if `triggeredAt` is `2026-05-15`, the changelog date is `May 16, 2026`.

---

## 4. Publishing workflow (manual, after automation drafts)

The automation does not publish anything. It only writes drafts to `release-drafts/v<NEW_VERSION>/` on the working branch and pushes them. Publishing is a two-step manual process for the maintainer:

1. **GitHub release** — Copy the body of `github-release.md` into a new release on `firecrawl/firecrawl` with tag `v<NEW_VERSION>`.
2. **Changelog post** — Copy `changelog-post.mdx` into the **separate** `firecrawl/web` repo (the firecrawl.dev site), at whatever path the changelog content uses, and open a PR there. The site repo is what makes the post show up on https://www.firecrawl.dev/changelog — `firecrawl/firecrawl` does not host the changelog.

The agent's `git push` only puts the drafts on the working branch of `firecrawl/firecrawl`. It is **not** "publishing the changelog." Do not assume committing here makes anything live.

---

## 5. GitHub release formatting

Canonical reference: the v3.0.0 release body (May 2026 edit). Match this styling exactly.

### Section order

```
# Firecrawl v<NEW_VERSION>

## Improvements
- **bolded headline item** — body...
- **bolded headline item** — body...

## Fixes
- Resolved multiple CVEs ...    ← consolidated security bullet FIRST
- Fixed ...
- Fixed ...

## API
- Added ...
- Deprecated ...
- Removed ...

---

**Full Changelog**: https://github.com/firecrawl/firecrawl/compare/v<PREV>...v<NEW_VERSION>
```

There is **no** `New Contributors` or `Contributors` section. GitHub auto-generates one on the release page; the curated body should not duplicate it.

### Improvements section
- **Every bullet uses a bolded lead title** followed by an em dash (` — `) and 1–3 sentences of body copy: `- **Feature title** — Description sentence(s).`
- **No plain-sentence trailing items.** Even small additions (config flags, SDK helpers, axios timeout) get a bolded title. Examples: `**Docker harness**`, `**JS SDK request timeout**`, `**PDF size cap**`, `**PDF page-processed billing**`.
- Lead titles wrap inline code in backticks where the title names an API field, endpoint, parameter, format, etc. Examples: `` **`/parse` endpoint** ``, `` **`question` format** ``, `` **`/interact` suggestion** ``, `**Lockdown Mode**`, `**Ruby SDK**`.
- SDK title convention: `**Ruby SDK**`, `**PHP SDK**`, `**.NET SDK**` (short form). The exception is `**Official Go SDK**`, which keeps the "Official" prefix because it replaces a community module.
- Order roughly from biggest user impact (new endpoints, new product modes, new formats) → new SDKs → smaller enhancements. Do not sort alphabetically.
- Aim for ~15–20 bullets total. Cut aggressively (see §7).

### Fixes section
- **No bolded lead titles.** Every bullet is a single plain sentence starting with a past-tense verb (`Fixed`, `Resolved`, `Patched`, `Hardened`).
- Use ` — ` only inline for a brief consequence clause: `Fixed X — now returns Y.`
- **Place the consolidated CVE/security bullet at the TOP** of Fixes for front-loaded visibility.
- Skip test-site / dev-only / internal-tooling fixes entirely (e.g. an `astro` upgrade in `test-site` to patch a `define:vars` advisory is not customer-facing).

### API section
- **No bolded lead titles.** Every bullet is a single plain sentence starting with `Added`, `Deprecated`, `Removed`, `Renamed`, `Migrated`, `Changed`, etc.
- Inline code in backticks for endpoints (`POST /v2/parse`), parameters (`lockdown: boolean`), error codes (`SCRAPE_LOCKDOWN_CACHE_MISS`), and request shapes.
- Include defaults, error codes raised, billing impact, and SDK availability when relevant.
- Deprecations and endpoint removals always go here, never in Improvements — even when framed as "Added deprecation warnings on legacy endpoints."

### Typography
- Use em dash ` — ` (U+2014, surrounded by spaces) between bold title and body, and between a clause and its consequence.
- Inline backticks for any code identifier (endpoints, fields, env vars, error codes, file extensions like `.xlsx`).
- Past tense throughout (`Added`, `Fixed`, `Resolved`).
- One sentence per change. Two or three sentences only for the largest feature bullets.

---

## 6. Changelog post formatting (`changelog-post.mdx`)

The firecrawl.dev changelog post is shorter and uses a single `### Highlights` list — not the Improvements/Fixes/API split.

### Structure
```mdx
---
title: "v<NEW_VERSION> is live"
date: "Month D, YYYY"   ← run date + 1 day
description: "One-sentence summary of the release."
---

## v<NEW_VERSION> is live

One-line intro paragraph naming the headline features.

### Highlights

- **Bolded title** — 1–2 sentence body.
- **Bolded title** — 1–2 sentence body.
- ... (6–10 highlights, picked from the GitHub release Improvements)

Read the full changelog [here](https://github.com/firecrawl/firecrawl/releases/tag/v<NEW_VERSION>).
```

- Every Highlights bullet uses the same bolded-lead pattern as the GitHub release Improvements.
- No Fixes, no API section, no contributors.
- The footer link points at the GitHub release tag URL.

---

## 7. Filtering rules — cut aggressively

Apply these filters **before** writing any bullet, not after.

### Always cut
- **Observability and tracing integrations that aren't a user-visible API.** E.g. "LangSmith tracing for `/interact` browser sessions," Sentry plumbing, OpenTelemetry wiring. Cut.
- **Generic "pipeline improvements" without a concrete user-visible delta.** E.g. "Improved PDF parsing reliability with clearer timeout handling and explicit deadline contracts." Rewrite around the concrete user-visible change (size cap, billing accuracy) or cut.
- **"Routed through a dedicated engine / flag" framing.** Internal routing plumbing, not user impact. Cut unless there is a measurable customer-visible improvement.
- **Test-site, harness, CI, or playwright-test changes.** Unless the change is a self-host-facing config (e.g. `HARNESS_STARTUP_TIMEOUT_MS` exposed in docker-compose), drop it.
- **"Allowlisted CVE X" notes.** Internal triage decisions, not fixes.
- **`Contributors` / `New Contributors` sections.** GitHub auto-renders them on the release page.
- **Vendor names users don't recognize** (Autumn, Supabase, calamine, Knip, tlsclient, etc.). Rewrite around the user-visible effect or cut.
- **Marketing framing carried over from PR descriptions.** "Fails loudly instead of silently," "explicit deadline contracts," and similar implementation-pride phrasing. Rewrite to the user-visible delta or cut.
- **Internal infrastructure dressed up as user-facing fixes.** E.g. "Fixed transient browser-session insert failures with retries on Supabase errors." If the visible effect is unclear, cut.

### Always keep
- New endpoints, formats, parameters, response fields, error codes.
- New SDKs, SDK promotions, and SDK release tags.
- Breaking changes, deprecations, removals.
- User-visible billing changes.
- Security advisories — consolidated into a single bullet, placed at the top of Fixes.
- Bug fixes with a clear user-visible symptom (e.g. `Fixed X being billed twice...`, `Fixed JS SDK watcher emitting duplicate events...`).

### CVE consolidation
When many CVEs land together, consolidate into a single bullet listing affected packages: `Resolved multiple CVEs across the API and SDKs including axios, postcss, fast-xml-parser, protobufjs, ...`. List individual GHSA/CVE IDs only if the audience audits by CVE.

---

## 8. Changelog-writer skill (canonical, embedded)

Use this for filtering and rewriting commit messages into bullets.

### Tone
- **Direct and action-oriented.** Lead with strong verbs (`Added`, `Fixed`, `Improved`, `Updated`, `Enhanced`, `Resolved`). No marketing fluff.
- **User-centric.** Write from the user's perspective. Focus on what they can now do or what problem was solved. Use "your" for user data/actions.
- **Concise and scannable.** One sentence per change (two maximum for complex items). Parallel structure within sections.
- **Technical but accessible.** Use precise terms without over-explaining. Assume product familiarity.
- **Neutral and factual.** No exclamation points, no "we're excited" phrasing, past tense for completed work.

### Sectioning
- **Improvements** — new features, enhancements, and additions that expand functionality.
- **Fixes** — bug fixes, security vulnerability resolutions, and corrections to existing functionality. Always include security/CVE fixes here, consolidated and at the top.
- **API** — API surface changes that developers need to know about for their integrations. Include: new endpoints/methods/params/response fields, breaking changes, deprecations and removals, auth/authorization changes, rate-limit changes. Exclude: internal infrastructure refactoring, backend database changes, internal architecture without API-surface impact.

### Format
Each bullet follows: `[Action verb] [what was done and impact]`.

In the GitHub release Improvements section, prefix with a bolded lead title: `- **Lead title** — Description.`

---

## 9. Source aggregation

- List commits since the previous tag: `git log v<PREV>..HEAD --oneline`.
- Inspect PR bodies for context on major features: `gh pr view <num> --json title,body`.
- Group commits by category using the skill in §8 and the filtering rules in §7.
- Re-check the latest tag at run start (do not hardcode).

---

## 10. Git workflow

- Develop on the branch assigned by the cloud agent task (the dashboard configures this; e.g. `cursor/release-changelog-generation-<id>`).
- Write the two draft files under `release-drafts/v<NEW_VERSION>/`.
- Commit with a descriptive message and push.
- **The push only saves drafts on this repo.** It does not create a GitHub release and it does not publish anything to firecrawl.dev. The maintainer publishes manually per §4.

---

## 11. Dashboard prompt (what the cron should say)

Keep the prompt short. Suggested text:

> Generate the next Firecrawl release draft and changelog post. Read `release-drafts/AUTOMATION.md` in the repo and follow it exactly. Write the two deliverables under `release-drafts/v<NEW_VERSION>/`, commit on the assigned branch, and push. Do not attempt to publish; the maintainer handles GitHub release publication and the cross-repo changelog PR to `firecrawl/web`.
