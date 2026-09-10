# Firecrawl Build Skills

Source of truth for the Firecrawl **build skills** — agent skills for integrating Firecrawl APIs into product code (SDKs, REST, endpoint selection, API keys).

Edit them here. CI mirrors this directory into the [`firecrawl/skills`](https://github.com/firecrawl/skills) catalog under `skills/build/`, which is where users install from:

```bash
npx skills add firecrawl/skills --skill firecrawl-build
```

Routing rule for other skill types: CLI skills (including the research/developer index skills) → [`firecrawl/cli`](https://github.com/firecrawl/cli). Workflow skills → [`firecrawl/firecrawl-workflows`](https://github.com/firecrawl/firecrawl-workflows). The catalog ([`firecrawl/skills`](https://github.com/firecrawl/skills)) is read-only.

Note: cross-skill links inside SKILL.md files are sibling-relative (`../firecrawl-x/SKILL.md`) on purpose — installed skills live flat in one directory, so the links resolve at install time even though some targets (e.g. the reference-index skills) are not present in this repo's tree.
