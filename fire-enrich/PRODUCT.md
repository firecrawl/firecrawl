# Fire Enrich

> Bootstrapped from README.md and the existing brand assets (`apps/web/colors.json`, `apps/web/tailwind.config.ts`). Refine via `/impeccable teach` when there is time.

## Register

**product** — internal/operator UI. The user is in a task: testing Firecrawl endpoints, managing API tokens, watching enrichment jobs run. The interface should disappear.

## Users

- **Operators / power users** running ad-hoc Firecrawl calls (scrape, crawl, search, map, extract, batch-scrape) against the team's pooled credentials. They know the API; they want to validate behavior fast and copy results out.
- **Admins** issuing per-principal bearer tokens with quotas and BYOK overrides. They expect the surface to feel like a small piece of internal infra (Stripe-dashboard energy), not a marketing site.
- **Pipeline builders** uploading CSVs to enrich with multi-agent AI (the original fire-enrich product).

All three sit in front of the same app. They share a sidebar.

## Product purpose

A single front-end on top of two backends:
1. **Firecrawl playground** — a thin, opinionated UI over the public Firecrawl API. One panel per endpoint, plus a job/SSE status view.
2. **CSV enrichment** — the multi-agent pipeline that takes a column of emails and produces company profiles, funding, tech stack, and arbitrary user-defined fields.

A small **admin** layer (principals, quotas, BYOK) is bolted on the side so a team can share one deployment without sharing one API key.

## Brand

The product is built on top of [Firecrawl](https://firecrawl.dev). The brand is Firecrawl's:

- **Heat orange** (`#fa5d19`) is the only hot color. Used sparingly: brand mark, primary action, active state. Never decoration.
- **Tinted neutrals** (`accent-black`, `border-faint/muted/loud`, `background-base/lighter`, `black-alpha-N`) carry 90% of the surface.
- **SuisseIntl** for UI. **Geist Mono** / **Roboto Mono** for code, IDs, tokens, JSON.
- The vibe is Linear / Stripe / Vercel — calm, dense, monospace where it belongs, no gradients, no hero-metric template, no decorative motion.

## Anti-references

- Marketing-site Firecrawl pages with the gradient drenched orange. This is the *operator* surface, not the landing page.
- Generic shadcn dashboards with drop-shadows, oversized cards, and a friendly emoji empty state. Too soft.
- "AI-app" tropes: glowing borders, sparkle icons everywhere, glassmorphism on input groups.

## Strategic principles

1. **Density beats whitespace.** This is a tool. The user wants to see request, response, and status on one screen. Big airy hero spacing belongs on the marketing site.
2. **Mono where data lives.** URLs, tokens, JSON, IDs, headers, durations — all monospace. Prose stays in SuisseIntl.
3. **One accent.** Heat orange shows up on the active nav item, the primary submit, and nowhere else. Status colors (`accent-forest`, `accent-crimson`, `accent-honey`, `accent-bluetron`) are state, not decoration.
4. **Familiar patterns.** Sidebar nav. Form on the left, response on the right. Tabs over `Markdown / HTML / JSON`. Don't reinvent.
5. **The tool disappears.** The user should remember the response, not the chrome.
