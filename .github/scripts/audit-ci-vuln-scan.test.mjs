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
