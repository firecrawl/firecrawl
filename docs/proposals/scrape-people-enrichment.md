# People enrichment on Scrape: development draft

This branch isolates the existing local prototype for review. It is not ready to enable.

With EXCHANGE_ENRICHMENT_ON_SCRAPE unset, enrichment execution is disabled. The prototype adds authenticated preference/plan proxies and, after a successful v2 scrape, consults the team plan and attempts providers sequentially. No production configuration is changed.

## Remaining before activation

- Integrate before the blocked-profile scrape path where appropriate, without allowing ordinary scraping of blocked URLs. The current post-success hook cannot serve a LinkedIn URL that fails scraping.
- Use the established authenticated Exchange retrieval, provider terms, entitlement and credit reservation/settlement path. Direct calls here do not prove customer billing or terms enforcement. The current billing comment is not an implementation guarantee.
- Replace generic non-empty response matching with per-provider profile adapters, identity checks, explicit no-match and pending outcomes, and contact-field filtering.
- Enforce a shared request deadline and cancellation, idempotency and retention policy. A caller signal must be combined with step timeouts.
- Add harness happy/failure integration tests for enabled/disabled preferences, blocked URLs, terms, fallback, errors and billing. Existing mocked unit tests are not an end-to-end validation.

Dependencies: Exchange #722 (preferences and planning) and web #3815 (configuration UI). Confirm deployed contracts before running. No PR has been opened for this branch.
