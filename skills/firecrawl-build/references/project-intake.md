# Project Intake

Before implementing Firecrawl in product code, classify the task:

## Fresh Project

Use this path when the user is starting a new app, workflow, or prototype.

Default flow:

1. Confirm the target language or stack.
2. Install the matching SDK, or use REST if that is a better fit.
3. Add `FIRECRAWL_API_KEY` to `.env` or the runtime secret store.
4. Create the smallest useful Firecrawl call for the product.
5. Run the smoke test in [verification.md](verification.md).

## Existing Project

Use this path when the user wants Firecrawl added to an existing codebase.

Inspect the repo first and identify:

- language and framework
- package manager
- project structure and file conventions
- entry points, routes, workers, or jobs where Firecrawl should live
- existing networking or third-party API wrappers
- how environment variables and secrets are managed
- any existing scraping, crawling, or browser-automation code

After inspection, ask:

- **What should Firecrawl do in this product?**

Route from that answer:

- known URL -> `/scrape`
- query first -> `/search`
- clicks, forms, login, or navigation after scrape -> `/interact`

Then install the SDK or use REST in the place that matches existing project conventions, not wherever is easiest in the moment.
