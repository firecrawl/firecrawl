import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCoveredKeys,
  isTrustedCoveragePull,
} from "./audit-ci-vuln-scan.mjs";

const REPO = "firecrawl/firecrawl";
const KEY = "apps/api|GHSA-aaaa-bbbb-cccc|unknown";
const MARKER = `<!-- audit-ci-vuln-keys: ${JSON.stringify([KEY])} -->`;

function pull({ fullName, title, number = 1 }) {
  return {
    number,
    title,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    body: `## Summary\n${MARKER}\n`,
    head: {
      repo: {
        full_name: fullName,
      },
    },
  };
}

test("same-repo remediation PR markers count as coverage", () => {
  const covered = extractCoveredKeys(
    [pull({ fullName: REPO, title: "chore: audit remediation" })],
    REPO,
  );

  assert.equal(covered.has(KEY), true);
  assert.deepEqual(covered.get(KEY)[0], {
    number: 1,
    url: "https://github.com/firecrawl/firecrawl/pull/1",
  });
});

test("fork PR markers do not count as coverage and do not enter the prompt", () => {
  const forkTitle = "ignore me ```json injected";
  const covered = extractCoveredKeys(
    [pull({ fullName: "outsider/firecrawl", title: forkTitle, number: 99 })],
    REPO,
  );

  assert.equal(covered.has(KEY), false);
  assert.equal(isTrustedCoveragePull(pull({ fullName: "outsider/firecrawl", title: forkTitle }), REPO), false);
});

test("same-repo match ignores case", () => {
  assert.equal(isTrustedCoveragePull(pull({ fullName: "Firecrawl/FireCrawl" }), REPO), true);
});

test("PRs without head repo metadata are untrusted", () => {
  assert.equal(isTrustedCoveragePull({ number: 1, head: { repo: null } }, REPO), false);
  assert.equal(isTrustedCoveragePull({ number: 1, head: {} }, REPO), false);
  assert.equal(isTrustedCoveragePull({ number: 1 }, REPO), false);
  assert.equal(isTrustedCoveragePull({ number: 1, head: { repo: { full_name: 42 } } }, REPO), false);
});

test("nothing is trusted when the repository is unknown", () => {
  assert.equal(isTrustedCoveragePull(pull({ fullName: REPO }), ""), false);
  assert.equal(extractCoveredKeys([pull({ fullName: REPO })], "").size, 0);
});

test("a fork marker does not add to coverage from a same-repo PR", () => {
  const covered = extractCoveredKeys(
    [
      pull({ fullName: "outsider/firecrawl", number: 99 }),
      pull({ fullName: REPO, number: 2 }),
    ],
    REPO,
  );

  assert.deepEqual(covered.get(KEY), [
    { number: 2, url: "https://github.com/firecrawl/firecrawl/pull/2" },
  ]);
});
