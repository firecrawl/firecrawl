# Camoufox service

A stealth browser-rendering service used as a **selective fallback**, not as a
replacement for the Playwright/Chromium service.

Firecrawl calls it only after an ordinary engine came back with anti-bot
evidence, and at most once per scrape job. 404s, DNS failures, TLS errors,
malformed URLs, unsupported downloads and ordinary parse failures never reach
it. See `apps/api/src/scraper/scrapeURL/engines/camoufox/index.ts` for the gate
and `apps/api/src/scraper/scrapeURL/lib/antibot.ts` for the classifier.

## Contract

Identical to `apps/playwright-service-ts`, so the scrape pipeline consumes both
with the same code path:

```
POST /scrape
  {url, wait_after_load?, timeout?, headers?, check_selector?, skip_tls_verification?}
  -> {content, pageStatusCode, contentType?, pageError?}

GET /health
  -> {status, maxConcurrentPages, activePages, browserLaunches, pagesServed, connected}
```

One addition, which the Playwright contract has no field for:

```
POST /screenshot
  {url, wait_after_load?, timeout?, full_page?}
  -> {screenshot: <base64 PNG>, pageStatusCode, title, degraded?}
```

Nothing in the Firecrawl scrape path depends on `/screenshot`.

## Pinned versions

Both the Python package and the browser build are pinned. An unbounded
`latest` would silently change the fingerprint — and therefore the detection
profile — on every rebuild.

| Component | Version | Where |
|---|---|---|
| `camoufox[geoip]` | `0.5.4` | `requirements.txt` |
| `playwright` | `1.60.0` | `requirements.txt` (camoufox requires `<1.61`) |
| `aiohttp` | `3.13.2` | `requirements.txt` |
| Camoufox browser | `152.0.4-beta.28` | `Dockerfile` `ARG CAMOUFOX_BROWSER_VERSION` |

To move the browser build:
`docker compose build --build-arg CAMOUFOX_BROWSER_VERSION=<version> camoufox-service`

## Cloak configuration

Each setting answers a specific documented detection vector.

| Setting | Default | Why |
|---|---|---|
| Own Xvfb at `1920x1080x24` | on | Camoufox's built-in `headless="virtual"` starts Xvfb with `-screen 0 1x1x24` ([camoufox#458](https://github.com/daijro/camoufox/issues/458)). A 1×1 screen is a blatant automation tell and a prime suspect in the "detected only inside Docker" reports ([camoufox#311](https://github.com/daijro/camoufox/issues/311)). We start our own display and hand Camoufox the number. |
| Native headless | **never used** | The Camoufox docs state headless mode remains detectable and recommend a virtual display. |
| Mesa software GL | installed | WebGL that returns *nothing* is a stronger signal than a spoofed renderer. |
| `CAMOUFOX_OS` | `windows` | Windows dominates real desktop traffic; Camoufox keeps UA, platform, fonts and WebGL consistent with it. |
| `CAMOUFOX_GEOIP` | `true` | Derives timezone/locale/geolocation from the real exit IP. An incoherent timezone-vs-IP pair is one of the cheapest checks a WAF runs. |
| `CAMOUFOX_HUMANIZE` | `true` | Human-like cursor movement. Zero pointer/scroll activity is a documented reason to be escalated to an interactive challenge. |
| `CAMOUFOX_FINGERPRINT_PRESET` | `true` | Uses real captured fingerprint presets instead of synthetic BrowserForge combinations. Camoufox's own stealth notes name internal *inconsistency* as the primary vulnerability. |
| Caller `User-Agent` | ignored | Overriding just the UA reintroduces exactly the inconsistency that gets stealth browsers caught. Other headers are forwarded. |
| Fresh `BrowserContext` per request | on | Per-job isolation of cookies and storage. The browser process is shared; contexts are not. |
| WebRTC / WebGL blocking | off | Camoufox spoofs both; their conspicuous absence is easier to detect than a spoofed value. |

## SSRF

Two mandatory layers, in `ssrf.py`:

1. `assert_safe_target_url` — runs before navigation and again for **every**
   request the page makes, including redirects and subresources.
2. `SsrfGuardProxy` — a loopback-only forward proxy the browser is pinned to.
   The browser never resolves DNS or opens sockets itself. The proxy resolves
   the name, refuses unless **every** returned address is globally routable,
   then dials the exact address it validated. Pinning the dialled address is
   what closes the DNS-rebinding window: there is no second lookup to poison.

Blocked: loopback, link-local (incl. `169.254.169.254`), multicast, RFC1918,
IPv6 unique-local, reserved, unspecified, CGNAT, and IPv4 addresses smuggled
inside IPv6 (v4-mapped, 6to4, Teredo). Ports are limited to 80/443/8080/8443.

**There is deliberately no `ALLOW_LOCAL_WEBHOOKS` escape hatch here.** That
override exists on the Playwright service so the self-hosted test suite can
scrape a local test site. Camoufox only ever runs against public sites that
answered with an anti-bot challenge, so extending the override to this service
would broaden it for no benefit.

The container has no `ports:` mapping — it is reachable only from the API
container on the Docker-internal `backend` network.

## Tests

```bash
cd apps/camoufox-service && python -m unittest discover -s tests -v
```
