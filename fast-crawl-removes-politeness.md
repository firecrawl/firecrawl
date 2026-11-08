# Fast Crawl: remove Firecrawl's politeness throttles

Date: 2026-09-11 · Branch: `dev` · Status: ready to implement
Audience: implementer with zero Firecrawl context. Every step names exact files,
shows the exact current text and the exact replacement, and ends with a
verification command + expected output. Do not guess — if a snippet does not
match the file, re-read the file before editing.

---

## Gap closure — remaining politeness gates (2026-11-08)

Branch `fast-crawl-close-gaps`. FAST_CRAWL originally left four
rule-following gates untouched. All are now short-circuited by the same
flag, each with a RED-first test:

| Gate | Site | Change | Test |
|------|------|--------|------|
| Per-scrape robots check (team flag `checkRobotsOnScrape`) | `scraper/scrapeURL/shouldCheckRobots.ts` | returns `false` under FAST_CRAWL | `shouldCheckRobots.test.ts` + snip `scrape-robots.test.ts` |
| Ops domain blocklist | `scraper/WebScraper/utils/blocklist.ts` `isUrlBlocked` | returns `false` under FAST_CRAWL (single choke point for all call sites) | `blocklist.test.ts` |
| Keyless per-IP request + credit caps | `lib/keyless.ts` `consumeKeylessRequest`, `reserveKeylessCredits` | both short-circuit to ok under FAST_CRAWL | `lib/keyless.fast-crawl.test.ts` |
| `robotsUserAgent` enterprise gate | `lib/permissions.ts` `checkPermissions` | gate bypassed under FAST_CRAWL (mirrors ignoreRobotsTxt) | `permissions.test.ts` |

Verification: 42/42 unit+snip tests pass, `tsc --noEmit` clean. The
fast-crawl parallel-crawl snip's 403 at crawl-start is a pre-existing
environment issue (fails identically on the untouched tree).

Deliberately NOT touched: Spur suspicious-IP check (reputation heuristic,
not a rule), `hasOrgScopedBlocklist` (cache-correctness opt-out, harmless
when blocking is off).

---

## Goal

Make this self-hosted Firecrawl API crawl fast and in parallel: ignore
robots.txt, fetch pages in parallel, no per-minute 429 ceiling, no
delay-based serialization — all gated behind one new env flag `FAST_CRAWL`
so the change is a single toggle and one revert.

## Current context / assumptions

Verified deployment facts (do not re-derive, they were checked 2026-09-11):

- Self-hosted mode: `USE_DB_AUTHENTICATION` is not `true`, so
  `isSelfHosted()` (`apps/api/src/lib/deployment.ts:2`) is true and the Autumn
  billing client is absent. `autumnService.getEntityLimits`
  (`apps/api/src/services/autumn/autumn.service.ts:669`) returns
  `{ concurrency: null, rateLimitMultiplier: null }`, so the code falls back
  to its low defaults.
- No Fire Engine (`FIRE_ENGINE_BETA_URL` unset). Playwright microservice IS
  running (`PLAYWRIGHT_MICROSERVICE_URL` set; compose service
  `playwright-service`, `MAX_CONCURRENT_PAGES` = `CRAWL_CONCURRENT_REQUESTS`
  default 10, docker-compose.yaml:84).
- Per-page engine waterfall for plain HTML therefore tries **playwright
  (browser) before fetch (plain HTTP)**: in
  `apps/api/src/scraper/scrapeURL/engines/index.ts`, `engines` array
  (line ~72-89) lists playwright before fetch, and engine quality is
  playwright `20` (line 398) vs fetch `5` (line 461). The list is sorted by
  `getEffectiveQuality` (line ~831) and the positive-quality filter (line
  ~797) keeps both, so the browser is tried first.

The five politeness/throttle mechanisms to remove, with their exact sites:

| # | Mechanism | Enforcement site (verified) |
|---|-----------|------------------------------|
| 1 | robots.txt respected + fetched per crawl | `crawlToCrawler` in `apps/api/src/lib/crawl-redis.ts` (line 599; `ignoreRobotsTxt:` property ~line 627); fetch in `WebCrawler.getRobotsTxt` `apps/api/src/scraper/WebScraper/crawler.ts:468`; decision gate `isRobotsAllowed` `crawler.ts:824`; 7 call sites fetch robots: v0/crawl.ts:247, v1/crawl.ts:245, v2/crawl.ts:305, v1/map.ts:159, lib/map-utils.ts:158, services/monitoring/runner.ts:625, v0/admin/crawl-monitor.ts:77 — all funnel through `crawlToCrawler`, so one edit covers all |
| 2 | Crawl parallelism clamped to 2 per crawl | `getEffectiveConcurrencyLimit` `apps/api/src/lib/concurrency-limit.ts:33` (`DEFAULT_CONCURRENCY_LIMIT = 2`, line 24); clamps in v2/crawl.ts:293, v1/crawl.ts:227, v0/crawl.ts:257; stored as FDB group meta `m`; gate `apps/api/src/services/worker/nuq-fdb/queue.ts:449` |
| 3 | Per-page `delay` serializes the crawl (delay>0 → concurrency forced to 1) | `queue.ts:449` (`effM = (gMeta.d ?? 0) > 0 ? 1 : gMeta.m`) and `apps/api/src/services/worker/nuq-fdb/ops.ts:408` (`crawlDelaySeconds = gMeta.d ?? 0`). Request schemas: v1/types.ts:879, v2/types.ts:1144 (`delay` optional, no default — only active if the caller sends it) |
| 4 | Per-minute rate limit → HTTP 429 | `BASE_RATE_LIMITS` `apps/api/src/services/rate-limiter.ts:52` (scrape 10/min, crawl 2/min, search 10/min, extract 2/min, browser 2/min, map 10/min); consumed at `apps/api/src/controllers/auth.ts:816`; self-hosted multiplier = 1 (autumn.service.ts:673) → base limits apply, and ALL API keys share one bucket (team_id `"bypass"`) |
| 5 | Browser engine tried before plain HTTP (slower per page) | `engines/index.ts` quality values above; the request option `fastMode` (v2/types.ts:707) already implements "fetch first" via the `useFastMode` feature flag — Task 6 reuses that mechanism |

Already fast, no action needed: `SCRAPEURL_ENGINE_WATERFALL_DELAY_MS`
defaults to 0 (config.ts), self-hosted bypasses team concurrency gates
(queue-jobs.ts:372-374, nuq-router.ts:254-256), per-page retries and
site-side-429 stealth-proxy retry are correctness features, not politeness.

## Architecture / proposed approach

Add one `z.stringbool()` flag `FAST_CRAWL` to the config schema, then
short-circuit each of the five mechanisms at its single chokepoint, each
guarded by `config.FAST_CRAWL`. One env toggle, five small guarded edits,
one revert. No schema or DB migration, no new services, no request-schema
changes. E2E "snips" (vitest) per AGENTS.md prove the win conditions.

## Pre-flight

### Task 0 — Baseline the dirty tree (decide, ~2 min)

The working tree has ~464 staged changes from prior uncommitted work
(checked via `git status --short --branch` at plan time). Per-task commits
below would swallow them otherwise.

1. Run: `git status --short | head -5` — expect `A`/`M` lines (staged) plus a
   few `??` untracked files.
2. ASK THE OPERATOR: commit the staged work as a baseline first? Default yes:
   ```
   git commit -m "chore: baseline prior staged work before fast-crawl changes"
   ```
   Expected: commit summary printed; `git status --short` now shows only
   untracked (`??`) lines.

---

## Implementation

### Task 1 — Add the FAST_CRAWL flag (~2 min)

File: `apps/api/src/config.ts`. In the `// Testing` block, immediately AFTER
the line `USE_DB_AUTHENTICATION: z.stringbool().optional(),` add one line:

```ts
  FAST_CRAWL: z.stringbool().optional(),
```

Verify:

```
cd apps/api && pnpm exec tsc --noEmit
```
Expected: exit 0, no output.

Commit: `git add apps/api/src/config.ts && git commit -m "feat(config): add FAST_CRAWL flag"`

### Task 2 — Write the failing tests (~15 min, RED)

**2a. Unit test for robots.** File: `apps/api/src/lib/crawl-redis.test.ts`.
Append at the top, after the existing import:

```ts
import { crawlToCrawler } from "./crawl-redis";
import { config } from "../config";
```
(change the existing `import { generateURLPermutations } from "./crawl-redis";`
to `import { generateURLPermutations, crawlToCrawler } from "./crawl-redis";`)

Append at the end of the file:

```ts
describe("crawlToCrawler FAST_CRAWL", () => {
  const sc = {
    originUrl: "https://example.com",
    crawlerOptions: {},
    scrapeOptions: {},
    internalOptions: {},
  } as any;

  afterEach(() => {
    delete (config as any).FAST_CRAWL;
  });

  it("forces ignoreRobotsTxt and skips the robots fetch when FAST_CRAWL", async () => {
    (config as any).FAST_CRAWL = true;
    const crawler = crawlToCrawler("fast-crawl-job-1", sc, null);
    expect((crawler as any).ignoreRobotsTxt).toBe(true);
    await expect(crawler.getRobotsTxt()).resolves.toBe("");
  });

  it("keeps the flag-gated robots behavior when FAST_CRAWL is unset", () => {
    const crawler = crawlToCrawler("fast-crawl-job-2", sc, null);
    expect((crawler as any).ignoreRobotsTxt).toBe(false);
  });
});
```

Run (unit, no harness needed):

```
cd apps/api && pnpm vitest run src/lib/crawl-redis.test.ts
```
Expected RED: the first test FAILS (`ignoreRobotsTxt` is `false`, and
`getRobotsTxt()` makes a real network call to example.com instead of
resolving `""`). The second test PASSES.

**2b. E2E snips for parallelism + rate limit.** New file
`apps/api/src/__tests__/snips/v2/fast-crawl.test.ts`:

```ts
import { TEST_SUITE_WEBSITE } from "../lib";
import {
  asyncCrawlWaitForFinish,
  crawlStart,
  Identity,
  idmux,
  scrapeRaw,
  scrapeTimeout,
  TEST_API_URL,
} from "./lib";
import request from "./lib";
import { describe, expect, it } from "vitest";

let identity: Identity;

describe("FAST_CRAWL: fast, parallel, unthrottled crawling", () => {
  it("crawls many pages in parallel (no 2-at-a-time clamp, no delay)", async () => {
    const { id } = await crawlStart(
      {
        url: TEST_SUITE_WEBSITE,
        limit: 25,
        maxConcurrency: 25,
        ignoreRobotsTxt: true,
        maxDepth: 2,
      },
      identity,
    );
    const result = await asyncCrawlWaitForFinish(id, identity);
    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    // Parallel crawl should collect a large share of the 25 allowed pages.
    // A serialized (delay=1) or clamped-to-2 crawl takes far longer and,
    // combined with the wait timeout, yields far fewer delivered pages.
    expect((result.data ?? []).length).toBeGreaterThanOrEqual(15);
  }, 10 * scrapeTimeout);

  it("does not return 429 for 15 concurrent scrapes", async () => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        scrapeRaw({ url: TEST_SUITE_WEBSITE, formats: ["markdown"] }, identity),
      ),
    );
    const statuses = responses.map(r => r.statusCode);
    expect(statuses.every(s => s === 200)).toBe(true);
  }, 10 * scrapeTimeout);
});
```

Notes for the implementer:
- `identity` must be set before the tests run. Copy the exact identity-setup
  pattern from the top of `apps/api/src/__tests__/snips/v2/crawl.test.ts`
  (a `beforeAll` that calls `idmux({ name: "fast-crawl", credits: 100000 })`
  and assigns to `identity`) and use it verbatim.
- `asyncCrawlWaitForFinish` / `crawlStart` signatures: confirm against
  `apps/api/src/__tests__/snips/v2/lib.ts` (crawlStart is at line ~412) and
  adjust only the argument shape if it differs; the assertions are the
  contract.
- These snips hit the local test site (`TEST_SUITE_WEBSITE`, default
  `http://127.0.0.1:4321`), which the harness starts. They must NOT be
  gated behind `TEST_PRODUCTION` — they are the self-hosted win conditions.

Run (RED, harness required, FAST_CRAWL NOT set):

```
cd <repo-root> && pnpm harness jest src/__tests__/snips/v2/fast-crawl.test.ts
```
(AGENTS.md's harness wrapper. If `harness` rejects the argument, run the
harness in one terminal — `cd <repo-root> && pnpm harness` — and in another:
`cd apps/api && pnpm vitest run src/__tests__/snips/v2/fast-crawl.test.ts`.)

Expected RED:
- "15 concurrent scrapes": FAILS — at least some responses are `429`
  (scrape mode base limit is 10/min, shared by all keys in self-hosted).
- "crawls many pages in parallel": may FAIL or may PASS depending on the
  queue backend (open question below). If it already PASSES, record that in
  the commit message of Task 5 — the FDB gate is not your active throttle —
  and still keep Task 5 (it de-clamps the explicit `maxConcurrency` request
  path regardless).

Commit: `git add apps/api/src/lib/crawl-redis.test.ts apps/api/src/__tests__/snips/v2/fast-crawl.test.ts && git commit -m "test(fast-crawl): add RED snips + robots unit test"`

### Task 3 — Ignore robots.txt (~5 min)

**3a.** File: `apps/api/src/lib/crawl-redis.ts`.
Add to the import block at top:

```ts
import { config } from "../config";
```

In `crawlToCrawler` (line 599), replace the `ignoreRobotsTxt` property
(current text):

```ts
    ignoreRobotsTxt:
      getIgnoreRobots(teamFlags) === "forced" ||
      (getIgnoreRobots(teamFlags) === "allowed" &&
        (sc.crawlerOptions?.ignoreRobotsTxt ?? false)),
```

with:

```ts
    ignoreRobotsTxt:
      config.FAST_CRAWL === true ||
      getIgnoreRobots(teamFlags) === "forced" ||
      (getIgnoreRobots(teamFlags) === "allowed" &&
        (sc.crawlerOptions?.ignoreRobotsTxt ?? false)),
```

Why this one line is enough for the decision: `WebCrawler.isRobotsAllowed`
(`apps/api/src/scraper/WebScraper/crawler.ts:824-836`) returns `true`
immediately when `ignoreRobotsTxt` is set, and `filterURL`
(`crawler.ts:719`) forwards the same flag, so no URL is ever dropped by
robots rules.

**3b.** Same file family, second file — `apps/api/src/scraper/WebScraper/crawler.ts`.
Add to imports (top of file):

```ts
import { config } from "../../config";
```

In `public async getRobotsTxt(` (line 468), insert as the FIRST statement of
the method body:

```ts
    if (config.FAST_CRAWL === true) return "";
```

Why: this skips the extra HTTP request to the target site's `/robots.txt`
(the "silently" part). An empty robots string parses to "allow all"
(`robotsParser` in the constructor, `crawler.ts:138-140`), which is already
the initial state, so behavior is identical to before the fetch existed.
All 7 call sites (v0/v1/v2 crawl, v1 map, map-utils, monitoring runner,
admin crawl-monitor) already wrap `getRobotsTxt` in try/catch and store the
result in `sc.robots`; an `""` round-trips fine through
`importRobotsTxt`.

Verify:

```
cd apps/api && pnpm exec tsc --noEmit                                  # exit 0
cd apps/api && pnpm vitest run src/lib/crawl-redis.test.ts             # all pass
```

Commit: `git add -A apps/api/src && git commit -m "feat(fast-crawl): ignore robots.txt and skip the robots fetch"`

### Task 4 — Lift the per-crawl concurrency clamp (~3 min)

File: `apps/api/src/lib/concurrency-limit.ts`.
Add import:

```ts
import { config } from "../config";
```

In `getEffectiveConcurrencyLimit` (line 33), insert as the first statement
of the body:

```ts
  if (config.FAST_CRAWL === true) return 1000;
```

Why 1000: the v0/v1/v2 crawl controllers clamp
`maxConcurrency = Math.min(requested, effectiveConcurrency)` (v2/crawl.ts:293,
v1/crawl.ts:227, v0/crawl.ts:257). Without a request the field stays
`undefined` (no clamp visible to the caller), and a requested value up to
1000 passes through. 1000 is "effectively unclamped" without being `Infinity`
in case the value is ever serialized or compared.

Verify: `cd apps/api && pnpm exec tsc --noEmit` → exit 0.
Commit: `git commit -am "feat(fast-crawl): raise effective concurrency cap when FAST_CRAWL"`

### Task 5 — Stop `delay` from serializing the crawl (~5 min)

Two edits, both guarded.

**5a.** File: `apps/api/src/services/worker/nuq-fdb/queue.ts`, line 449.
Add import at top:

```ts
import { config } from "../../../config";
```

Replace:

```ts
            const effM = (gMeta.d ?? 0) > 0 ? 1 : gMeta.m;
```

with:

```ts
            const effM =
              (gMeta.d ?? 0) > 0 && config.FAST_CRAWL !== true ? 1 : gMeta.m;
```

**5b.** File: `apps/api/src/services/worker/nuq-fdb/ops.ts`, line 408.
Add import at top:

```ts
import { config } from "../../../config";
```

Replace:

```ts
        crawlDelaySeconds = gMeta.d ?? 0;
```

with:

```ts
        crawlDelaySeconds = config.FAST_CRAWL === true ? 0 : (gMeta.d ?? 0);
```

Context: when a crawl group has `delaySeconds > 0`, the FDB queue forces the
group's crawl-gate concurrency to 1 (5a) and parks each promoted job behind
a not-before timestamp (5b). Under FAST_CRAWL the delay is ignored so pages
flow in parallel. These gates only run when the team's crawl queue uses the
FDB backend (`resolveNewGroupBackend`, `apps/api/src/services/worker/nuq-router.ts:106`);
on the PG backend the group opts are not stored (nuq-router.ts:684), which is
why Task 2's parallel snip may already pass before this task.

Verify: `cd apps/api && pnpm exec tsc --noEmit` → exit 0.
Commit: `git commit -am "feat(fast-crawl): ignore crawl delay in the FDB queue gates"`

### Task 6 — Remove the per-minute 429 ceiling (~3 min)

File: `apps/api/src/services/rate-limiter.ts` (`config` is already imported
at line 2). In `getAutumnRateLimiter` (line 84), insert as the first
statement of the body:

```ts
  if (config.FAST_CRAWL === true) multiplier = 1_000_000;
```

Why: authenticated requests consume the per-minute limiter at
`apps/api/src/controllers/auth.ts:816`; self-hosted mode builds it via
`buildAuthenticatedRateLimiter` (auth.ts:574) → `getAutumnRateLimiter(mode, 1)`
→ `BASE_RATE_LIMITS` (scrape 10/min, crawl 2/min, ...). Multiplying the base
by 1e6 makes the 60-second Redis window non-binding. Note it only scales the
`BASE_RATE_LIMITS` modes; status/poll modes already sit on the generous
`fallbackRateLimits` table and are untouched.

Verify: `cd apps/api && pnpm exec tsc --noEmit` → exit 0.
Commit: `git commit -am "feat(fast-crawl): raise per-minute rate limits when FAST_CRAWL"`

### Task 7 — GREEN run (~10 min)

Start the stack with the flag ON. `configDotenv()` does not override
existing process env, so a shell export wins:

```
export FAST_CRAWL=true
cd <repo-root> && pnpm harness jest src/__tests__/snips/v2/fast-crawl.test.ts
# fallback: harness in one terminal, then
# cd apps/api && pnpm vitest run src/__tests__/snips/v2/fast-crawl.test.ts
```

Expected GREEN: both snips pass, and (from Task 2) the unit test passes.
Also re-run the unit suite to be safe:
`cd apps/api && pnpm vitest run src/lib/crawl-redis.test.ts` → pass.

Then the regression gate before opening a PR:

```
cd apps/api && pnpm test:snips
```
Expected: the v1+v2 snips pass (the pre-existing robots warning test
`snips/v2/crawl.test.ts` "shows warning when robots.txt blocks URLs" hits
external `mairistumpf.com` — if it fails in your network environment it
fails identically with and without the flag; compare against a run with
`FAST_CRAWL` unset to confirm the flag didn't cause it). Leave the full
suite to CI per AGENTS.md.

### Task 8 (optional, per-page speed) — Fetch-before-browser (~5 min)

Goal: plain HTTP (`fetch` engine) instead of a browser render for ordinary
scrapes. The request option `fastMode` already does this: it sets the
`useFastMode` feature flag, whose priority (90, engines/index.ts:127) makes
the threshold (45) exclude playwright (`useFastMode: false`, line 393) and
keep fetch (`useFastMode: true`, line 456).

1. Find where the request's feature flags become `meta.featureFlags` —
   ```
   grep -n "featureFlags" apps/api/src/scraper/scrapeURL/index.ts | head
   ```
   (it is populated from the request options near where `meta` is built).
2. Add `import { config } from "../../config";` to
   `apps/api/src/scraper/scrapeURL/index.ts` if absent, then immediately
   after the `meta.featureFlags` construction:
   ```ts
   if (config.FAST_CRAWL === true) meta.featureFlags.add("useFastMode");
   ```
3. Verify: `tsc --noEmit` clean; then run one snip that scrapes a JS-heavy
   page (any existing v2 scrape snip against `TEST_SUITE_WEBSITE`) with
   `FAST_CRAWL=true` — expected: content still returns; the logs will show
   `engine.fallback_list` starting with `fetch`.

Tradeoff to know before shipping: with `useFastMode` forced, a fetch failure
has no browser fallback for that page (same semantics as the existing
`fastMode: true` request option). If any test regresses, drop this task and
ship Tasks 1-7 — it is the only optional item.

Commit: `git commit -am "feat(fast-crawl): prefer fetch engine over browser when FAST_CRAWL"`

---

## Tests / validation summary

| What | Command | Expected |
|------|---------|----------|
| Typecheck (after EVERY task) | `cd apps/api && pnpm exec tsc --noEmit` | exit 0 |
| Robots unit (RED at Task 2, GREEN at Task 3) | `cd apps/api && pnpm vitest run src/lib/crawl-redis.test.ts` | 2 new tests pass |
| Parallelism + no-429 snips (RED at Task 2, GREEN at Task 7) | `pnpm harness jest src/__tests__/snips/v2/fast-crawl.test.ts` (from repo root) | both pass with `FAST_CRAWL=true` in the harness env |
| Regression | `cd apps/api && pnpm test:snips` | v1+v2 snips pass (compare any flake against a flag-off run) |
| Full suite | CI | per AGENTS.md, don't run locally |

All scrape waits use `scrapeTimeout` from `./lib` per AGENTS.md.

## Risks, tradeoffs, and open questions

1. **Open question — the active parallelism throttle.** Self-hosted bypasses
   the team gate (queue-jobs.ts:372-374), and on the PG queue backend group
   `maxConcurrency`/`delay` are not even stored (nuq-router.ts:684). Your
   real per-page ceiling may instead be `NUQ_WORKER_COUNT` (default 5,
   config.ts) — i.e. only 5 scrape workers process page jobs concurrently —
   and/or `MAX_CONCURRENT_PAGES` (10) on the playwright service. The Task 2
   parallel snip measures actual delivered pages; if it already passes with
   the flag off, the fix for real parallelism is env, not code: raise
   `NUQ_WORKER_COUNT` (and `CRAWL_CONCURRENT_REQUESTS`) in `.env` /
   docker-compose. Verify empirically at Task 7 and record the number.
2. **Rate-limit scope.** Task 6 lifts the authenticated per-minute ceiling
   only. Keyless (no API key) traffic uses a separate per-IP quota path —
   out of scope; snips authenticate.
3. **Robots skip returns `""`.** Anything logging the robots body sees an
   empty string instead of an error; all 7 call sites already tolerate
   either (try/catch + `importRobotsTxt("")` is a no-op).
4. **FAST_CRAWL is all-or-nothing by design.** No per-endpoint granularity;
   YAGNI. If you later need "fast but respect robots for one site", that's a
   new flag, not an edit to this one.
5. **Deliberately NOT touched** (correctness/reliability, not politeness):
   retry budgets `SCRAPE_MAX_ATTEMPTS=6` and PDF/document prefetch budgets
   (config.ts), site-side-429 → stealth-proxy retry
   (scrapeURL/index.ts:600-620), `robotsUserAgent` identity, threat
   protection. Don't "clean them up" while in the neighborhood.
6. **Pre-existing dirty tree.** Task 0 isolates the ~464 staged changes so
   the per-task commits stay reviewable; the deliverable snip/CSV/handoff
   files stay untracked unless the operator wants them in.
