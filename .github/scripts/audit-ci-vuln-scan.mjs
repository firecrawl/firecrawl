#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const AUDITS = [
  { name: "API", appPath: "apps/api", outputName: "api" },
  {
    name: "Playwright Service",
    appPath: "apps/playwright-service-ts",
    outputName: "playwright-service",
  },
  { name: "JavaScript SDK", appPath: "apps/js-sdk", outputName: "js-sdk" },
  {
    name: "JavaScript SDK Firecrawl",
    appPath: "apps/js-sdk/firecrawl",
    outputName: "js-sdk-firecrawl",
  },
  {
    name: "Test Suite",
    appPath: "apps/test-suite",
    outputName: "test-suite",
  },
  {
    name: "Ingestion UI",
    appPath: "apps/ui/ingestion-ui",
    outputName: "ingestion-ui",
  },
  { name: "Test Site", appPath: "apps/test-site", outputName: "test-site" },
];

const GHSA_REGEX = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/gi;
const MARKER_REGEX = /<!--\s*audit-ci-vuln-keys:\s*(\[[\s\S]*?\])\s*-->/g;
const OUTPUT_DIR = process.env.AUDIT_REMEDIATION_OUTPUT_DIR || "/tmp/audit-remediation";
const GITHUB_API_URL = process.env.GITHUB_API_URL || "https://api.github.com";
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "";

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
  });
}

function auditCommand(appPath, extraArgs = []) {
  return [
    "dlx",
    "audit-ci@^7",
    "--directory",
    appPath,
    "--config",
    `${appPath}/audit-ci.jsonc`,
    ...extraArgs,
  ];
}

function commandForDisplay(appPath) {
  return `pnpm dlx audit-ci@^7 --directory ${appPath} --config ${appPath}/audit-ci.jsonc`;
}

function combinedOutput(result) {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function advisoryIdsFrom(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return unique(String(value).match(GHSA_REGEX) || []).map((id) => id.toUpperCase());
}

function advisoryIdsFromObject(value) {
  return advisoryIdsFrom(JSON.stringify(value));
}

function normalizeKey(appPath, advisoryId, packageName) {
  return `${appPath}|${advisoryId.toUpperCase()}|${packageName || "unknown"}`;
}

function pushFinding(findings, finding) {
  if (!finding.advisoryId) {
    return;
  }

  const packageName = finding.packageName || "unknown";
  const key = normalizeKey(finding.appPath, finding.advisoryId, packageName);
  const existing = findings.find((item) => item.key === key);

  if (existing) {
    existing.paths = unique([...existing.paths, ...(finding.paths || [])]);
    existing.severities = unique([...existing.severities, ...(finding.severities || [])]);
    existing.urls = unique([...existing.urls, ...(finding.urls || [])]);
    existing.titles = unique([...existing.titles, ...(finding.titles || [])]);
    return;
  }

  findings.push({
    key,
    appName: finding.appName,
    appPath: finding.appPath,
    advisoryId: finding.advisoryId.toUpperCase(),
    packageName,
    paths: unique(finding.paths || []),
    severities: unique(finding.severities || []),
    urls: unique(finding.urls || []),
    titles: unique(finding.titles || []),
  });
}

function extractJson(output) {
  const trimmed = output.trim();

  for (const [startToken, endToken] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const start = trimmed.indexOf(startToken);
    const end = trimmed.lastIndexOf(endToken);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Try the next shape before falling back to text parsing.
      }
    }
  }

  return null;
}

function collectFromVulnerabilities(report, audit) {
  const findings = [];
  const vulnerabilities = report?.vulnerabilities;

  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    return findings;
  }

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
    const paths = unique([
      ...(Array.isArray(vulnerability?.nodes) ? vulnerability.nodes : []),
      ...(Array.isArray(vulnerability?.effects) ? vulnerability.effects : []),
    ]);

    for (const viaEntry of via) {
      if (typeof viaEntry === "string") {
        continue;
      }

      const advisoryIds = advisoryIdsFromObject(viaEntry);
      for (const advisoryId of advisoryIds) {
        pushFinding(findings, {
          appName: audit.name,
          appPath: audit.appPath,
          advisoryId,
          packageName: viaEntry.name || packageName,
          paths,
          severities: [viaEntry.severity || vulnerability.severity],
          urls: [viaEntry.url],
          titles: [viaEntry.title],
        });
      }
    }
  }

  return findings;
}

function collectFromAdvisories(report, audit) {
  const findings = [];
  const advisories = report?.advisories;

  if (!advisories || typeof advisories !== "object") {
    return findings;
  }

  for (const advisory of Object.values(advisories)) {
    const advisoryIds = unique([
      ...advisoryIdsFrom(advisory.github_advisory_id),
      ...advisoryIdsFrom(advisory.url),
      ...advisoryIdsFrom(advisory.title),
      ...advisoryIdsFromObject(advisory),
    ]);
    const paths = [];

    if (Array.isArray(advisory.findings)) {
      for (const finding of advisory.findings) {
        paths.push(...(Array.isArray(finding.paths) ? finding.paths : []));
      }
    }

    for (const advisoryId of advisoryIds) {
      pushFinding(findings, {
        appName: audit.name,
        appPath: audit.appPath,
        advisoryId,
        packageName: advisory.module_name || advisory.name || "unknown",
        paths,
        severities: [advisory.severity],
        urls: [advisory.url],
        titles: [advisory.title],
      });
    }
  }

  return findings;
}

function collectFallbackFromText(output, audit) {
  const findings = [];
  const advisoryIds = advisoryIdsFrom(output);

  for (const advisoryId of advisoryIds) {
    pushFinding(findings, {
      appName: audit.name,
      appPath: audit.appPath,
      advisoryId,
      packageName: "unknown",
      paths: [],
      severities: [],
      urls: [],
      titles: [],
    });
  }

  return findings;
}

function collectFindings(report, output, audit) {
  const structuredFindings = [
    ...collectFromVulnerabilities(report, audit),
    ...collectFromAdvisories(report, audit),
  ];
  const structuredAdvisoryIds = new Set(
    structuredFindings.map((finding) => `${finding.appPath}|${finding.advisoryId}`),
  );
  const fallbackFindings = collectFallbackFromText(output, audit).filter(
    (finding) => !structuredAdvisoryIds.has(`${finding.appPath}|${finding.advisoryId}`),
  );

  return [...structuredFindings, ...fallbackFindings];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "audit-ci-vuln-scan",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function listOpenPullRequests() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    return [];
  }

  const pulls = [];
  for (let page = 1; ; page += 1) {
    const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/pulls?state=open&per_page=100&page=${page}`;
    const batch = await fetchJson(url);
    pulls.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return pulls;
}

function extractCoveredKeys(pulls) {
  const covered = new Map();

  for (const pull of pulls) {
    const body = pull.body || "";
    const markers = body.matchAll(MARKER_REGEX);

    for (const marker of markers) {
      try {
        const keys = JSON.parse(marker[1]);
        if (!Array.isArray(keys)) {
          continue;
        }

        for (const key of keys) {
          if (typeof key !== "string") {
            continue;
          }

          const existing = covered.get(key) || [];
          existing.push({
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
          });
          covered.set(key, existing);
        }
      } catch {
        // Ignore malformed markers rather than treating them as coverage.
      }
    }
  }

  return covered;
}

function buildMarker(keys) {
  return `<!-- audit-ci-vuln-keys: ${JSON.stringify(keys)} -->`;
}

function writeGithubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  if (String(value).includes("\n")) {
    const delimiter = `EOF_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function buildPrompt({ uncoveredFindings, coveredFindings, marker, commands }) {
  const uncoveredJson = JSON.stringify(uncoveredFindings, null, 2);
  const coveredJson = JSON.stringify(
    coveredFindings.map((finding) => ({
      key: finding.key,
      appPath: finding.appPath,
      advisoryId: finding.advisoryId,
      packageName: finding.packageName,
      coveredBy: finding.coveredBy,
    })),
    null,
    2,
  );

  return `PNPM Audit Failures Fix

You are fixing CI security audit failures in this monorepo and must mirror this repo's workflow exactly.

Source of truth:
- Workflow file: \`.github/workflows/npm-audit.yml\`
- Job: \`audit\` — a matrix with one \`Audit <name>\` job per package directory; each failed matrix job's log contains the audit-ci output for that package.
- Reproduce using the same \`audit-ci\` commands/flags used in that workflow.

Current uncovered audit failures on main:
- Patch only the vulnerability keys listed in this section.
- Do not spend effort on vulnerabilities listed as already covered by open PRs.
- Add this hidden marker inside the PR body's \`## Summary\` section:
  ${marker}

Uncovered vulnerability records:

\`\`\`json
${uncoveredJson}
\`\`\`

Already covered by open PR markers:

\`\`\`json
${coveredJson}
\`\`\`

CI-equivalent audit commands from \`.github/workflows/npm-audit.yml\`:
${commands.map((command) => `- \`${command}\``).join("\n")}

Decision policy (strict order):
1) Upgrade higher-level direct dependencies first (non-breaking only: patch/minor).
   - Goal: eliminate vulnerable transitive \`vite\` via parent upgrades (e.g. \`astro\` or app-level deps).
   - No major upgrades unless explicitly approved.
2) If still failing, add minimal targeted \`pnpm overrides\` / \`resolutions\` for vulnerable transitives.
3) If neither upgrades nor overrides can reach a non-vulnerable version:
   - Mark as \`BLOCKED\`
   - Document exact blocking dependency chain and required follow-up (likely major upgrade or upstream fix).
4) If advisory is not practically exploitable for this repo:
   - Provide evidence-based impact assessment (reachability, prod vs dev/build-only, exploit preconditions),
   - Then propose a temporary ignore with: reason, expiry date, owner, and tracking issue.

Override safety rules (important):
- Never use unbounded replacement ranges that can cross into a new major.
- For major-constrained selector overrides, the replacement must preserve the same major ceiling.
- Example of BAD override:
  - \`\"vite@>=6.0.0 <7.0.0\": \">=6.4.2\"\`  (can resolve to Vite 7/8)
- Example of GOOD override:
  - \`\"vite@>=6.0.0 <7.0.0\": \">=6.4.2 <7.0.0\"\`
- If deterministic pin is preferred, use exact patched version:
  - \`\"vite@>=6.0.0 <7.0.0\": \"6.4.2\"\`
- In the final explanation, explicitly state why the chosen override cannot drift to a higher major.

Mandatory local verification (must match workflow commands):
- Run exactly these commands locally (same tool/flags/targets as CI):
  - \`pnpm dlx audit-ci@^7 --directory apps/ui/ingestion-ui --config apps/ui/ingestion-ui/audit-ci.jsonc\`
  - \`pnpm dlx audit-ci@^7 --directory apps/test-site --config apps/test-site/audit-ci.jsonc\`
- If broader validation is needed, also run the other audit commands defined in \`.github/workflows/npm-audit.yml\`.
- Do not claim success unless these CI-equivalent local commands pass (or a documented temporary ignore/blocked path is approved).

PR requirements:
- Create a PR when done.
- PR body must contain only a **Summary** section (no **Test plan** section).
- Do not include any co-author lines/footers.
- Summary must be organized by app in this monorepo.
- Include the hidden \`audit-ci-vuln-keys\` marker exactly once inside the **Summary** section.
- For each app, list each package update and explicitly map it to the advisory/advisories it addresses.
- For each resolved package version used to fix the advisory, include its release date in the PR summary.
- If an override is used, include selector and replacement, and note the major-bound guarantee.
- If you update an SDK package, bump that SDK's package version as part of the same PR; otherwise the publish workflow will not publish the SDK changes.

Output format (exact):
## Findings
- Advisory: <GHSA>
- Severity: <...>
- Affected path(s): <...>
- Fixed by: <direct dep upgrade | override | blocked | temp ignore>
- Rationale: <short>

## Changes Made
- <file>: <change>
- <file>: <change>

## Local Verification (CI-equivalent)
- Workflow reference: \`.github/workflows/npm-audit.yml\`
- Commands run locally (exact):
  - \`<command>\`
- Results:
  - \`<pass/fail + key output>\`

## Decision Log
- Step 1 (direct upgrades): <success/fail + what tried>
- Step 2 (overrides): <success/fail + what tried>
- Step 3 (blocked?): <yes/no + reason>
- Step 4 (temp ignore needed?): <yes/no + evidence>

## PR Summary Draft (by app)
- \`<app path/name>\`
  - \`<package update>\` -> \`<GHSA(s)>\` (resolved version: \`<x.y.z>\`, release date: \`<YYYY-MM-DD>\`)
  - \`<override selector> => <replacement>\` -> \`<GHSA(s)>\` (major-bound: \`<explain bound>\`, resolved version: \`<x.y.z>\`, release date: \`<YYYY-MM-DD>\`)

## Risk / Follow-up
- Runtime impact: <affected/not affected/uncertain>
- If ignored: expires <date>, tracked in <ticket>, owner <team/person>
- Next recommended action: <one line>
`;
}

function writeStepSummary({ findings, coveredFindings, uncoveredFindings, outputDir }) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const lines = [
    "## Audit CI Vulnerability Scan",
    "",
    `- Current vulnerabilities on default branch: ${findings.length}`,
    `- Covered by open PR markers: ${coveredFindings.length}`,
    `- Uncovered vulnerabilities for Claude: ${uncoveredFindings.length}`,
    `- Output directory: \`${outputDir}\``,
    "",
  ];

  if (uncoveredFindings.length > 0) {
    lines.push("### Uncovered", "");
    for (const finding of uncoveredFindings) {
      lines.push(`- \`${finding.key}\``);
    }
  }

  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const findings = [];
  const auditResults = [];

  for (const audit of AUDITS) {
    const textResult = run("pnpm", auditCommand(audit.appPath));
    const textOutput = combinedOutput(textResult);
    const textOutputPath = path.join(OUTPUT_DIR, `${audit.outputName}.txt`);

    writeFileSync(textOutputPath, textOutput);
    process.stdout.write(textOutput);

    const failed = textResult.status !== 0;
    auditResults.push({
      ...audit,
      failed,
      command: commandForDisplay(audit.appPath),
      textOutputPath,
    });

    if (!failed) {
      continue;
    }

    const jsonResult = run("pnpm", auditCommand(audit.appPath, ["--output-format", "json"]));
    const jsonOutput = combinedOutput(jsonResult);
    const jsonOutputPath = path.join(OUTPUT_DIR, `${audit.outputName}.json`);
    writeFileSync(jsonOutputPath, jsonOutput);

    const report = extractJson(jsonOutput);
    const appFindings = collectFindings(report, `${textOutput}\n${jsonOutput}`, audit);

    if (appFindings.length === 0) {
      throw new Error(
        `${audit.name} audit failed, but no GHSA advisory IDs could be parsed from audit-ci output.`,
      );
    }

    for (const finding of appFindings) {
      pushFinding(findings, finding);
    }
  }

  const pulls = await listOpenPullRequests();
  const coveredKeys = extractCoveredKeys(pulls);
  const coveredFindings = [];
  const uncoveredFindings = [];

  for (const finding of findings) {
    const coveredBy = coveredKeys.get(finding.key);
    if (coveredBy) {
      coveredFindings.push({ ...finding, coveredBy });
    } else {
      uncoveredFindings.push(finding);
    }
  }

  const uncoveredKeys = uncoveredFindings.map((finding) => finding.key);
  const marker = buildMarker(uncoveredKeys);
  const prompt = buildPrompt({
    uncoveredFindings,
    coveredFindings,
    marker,
    commands: AUDITS.map((audit) => commandForDisplay(audit.appPath)),
  });

  const findingsPath = path.join(OUTPUT_DIR, "findings.json");
  const uncoveredPath = path.join(OUTPUT_DIR, "uncovered-findings.json");
  const coveredPath = path.join(OUTPUT_DIR, "covered-findings.json");
  const auditResultsPath = path.join(OUTPUT_DIR, "audit-results.json");
  const promptPath = path.join(OUTPUT_DIR, "claude-prompt.md");

  writeFileSync(findingsPath, `${JSON.stringify(findings, null, 2)}\n`);
  writeFileSync(uncoveredPath, `${JSON.stringify(uncoveredFindings, null, 2)}\n`);
  writeFileSync(coveredPath, `${JSON.stringify(coveredFindings, null, 2)}\n`);
  writeFileSync(auditResultsPath, `${JSON.stringify(auditResults, null, 2)}\n`);
  writeFileSync(promptPath, prompt);

  writeGithubOutput("has_uncovered", uncoveredFindings.length > 0 ? "true" : "false");
  writeGithubOutput("prompt", prompt);
  writeGithubOutput("prompt_file", promptPath);
  writeGithubOutput("marker", marker);
  writeGithubOutput("vuln_keys_json", JSON.stringify(uncoveredKeys));
  writeGithubOutput("uncovered_findings_json", JSON.stringify(uncoveredFindings));
  writeGithubOutput("uncovered_count", String(uncoveredFindings.length));
  writeGithubOutput("covered_count", String(coveredFindings.length));
  writeGithubOutput("findings_count", String(findings.length));

  writeStepSummary({
    findings,
    coveredFindings,
    uncoveredFindings,
    outputDir: OUTPUT_DIR,
  });

  if (uncoveredFindings.length === 0) {
    console.log("No uncovered audit-ci vulnerabilities found on the default branch.");
  } else {
    console.log(`Found ${uncoveredFindings.length} uncovered audit-ci vulnerability key(s).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
