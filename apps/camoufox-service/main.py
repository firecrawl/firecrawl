"""Camoufox browser-rendering service.

Speaks the same HTTP contract as ``apps/playwright-service-ts`` so the Firecrawl
scrape pipeline can consume it with no extra parsing:

    POST /scrape  {url, wait_after_load?, timeout?, headers?, check_selector?,
                   skip_tls_verification?}
              ->  {content, pageStatusCode, contentType?, pageError?}
    GET  /health  -> {status, ...}

Plus one endpoint the Playwright contract has no room for, since it cannot
carry binary payloads:

    POST /screenshot {url, wait_after_load?, timeout?, full_page?}
              ->  {screenshot: <base64 PNG>, pageStatusCode, title, degraded?}

It is a *fallback*: the API only calls it after an ordinary engine came back
with anti-bot evidence, at most once per scrape job.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from http import HTTPStatus
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from aiohttp import web

from browser import (
    BLOCK_MEDIA,
    NAVIGATION_TIMEOUT_MS,
    BrowserPool,
)
from ssrf import InsecureConnectionError, SsrfGuardProxy, assert_safe_target_url

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("camoufox.service")

PORT = int(os.environ.get("PORT", "3000"))

#: Navigation wait condition. `domcontentloaded` is the default deliberately —
#: see the note in _scrape_page. Set to `load` or `networkidle` only if a target
#: genuinely needs it.
WAIT_UNTIL = os.environ.get("CAMOUFOX_WAIT_UNTIL", "domcontentloaded").strip()

#: Settle delay after the wait condition, so client-rendered content lands.
try:
    SETTLE_MS = max(0, int(os.environ.get("CAMOUFOX_SETTLE_MS", "1200")))
except ValueError:
    SETTLE_MS = 1200

MEDIA_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    ".mp3", ".mp4", ".avi", ".flac", ".ogg", ".wav", ".webm",
)

AD_SERVING_DOMAINS = (
    "doubleclick.net",
    "adservice.google.com",
    "googlesyndication.com",
    "googletagservices.com",
    "googletagmanager.com",
    "google-analytics.com",
    "adsystem.com",
    "adservice.com",
    "adnxs.com",
    "ads-twitter.com",
    "facebook.net",
    "fbcdn.net",
    "amazon-adsystem.com",
)

STATUS_TEXT = {s.value: s.phrase for s in HTTPStatus}


def get_error(status: Optional[int]) -> Optional[str]:
    if status is None:
        return "No response received"
    if 200 <= status < 300:
        return None
    return STATUS_TEXT.get(status, f"HTTP {status}")


class SecurityState:
    """Records a navigation blocked by the route interceptor.

    Playwright surfaces an aborted navigation as a generic ``page.goto`` failure,
    so we stash the real reason here to report it accurately.
    """

    def __init__(self) -> None:
        self.blocked_navigation_url: Optional[str] = None


async def _install_route_guard(context: Any, state: SecurityState) -> None:
    async def handler(route: Any, request: Any) -> None:
        url = request.url
        try:
            # Cached: a single page can pull hundreds of subresources, and
            # resolving each one inline blows the navigation deadline. The
            # guard proxy still re-resolves for every real connection.
            await assert_safe_target_url(url, use_cache=True)
        except InsecureConnectionError as exc:
            if request.is_navigation_request():
                state.blocked_navigation_url = url
            logger.warning("Blocked request: %s (%s)", url, exc.reason)
            await route.abort("blockedbyclient")
            return

        host = (urlsplit(url).hostname or "").lower()
        if any(domain in host for domain in AD_SERVING_DOMAINS):
            await route.abort()
            return

        if BLOCK_MEDIA and any(
            urlsplit(url).path.lower().endswith(ext) for ext in MEDIA_EXTENSIONS
        ):
            await route.abort()
            return

        await route.continue_()

    await context.route("**/*", handler)


async def _humanize_page(page: Any) -> None:
    """Emit a little real-user activity.

    A session with zero pointer or scroll events is a documented reason for bot
    managers to escalate to an interactive challenge. Bounded and best-effort:
    never let the warm-up fail a scrape.
    """
    try:
        await page.mouse.move(360, 280)
        await page.mouse.move(640, 420)
        await page.evaluate("window.scrollBy(0, 320)")
        await page.wait_for_timeout(180)
        await page.evaluate("window.scrollTo(0, 0)")
    except Exception as exc:  # noqa: BLE001
        logger.debug("Humanize warm-up skipped: %s", exc)


def _cookie_domain(url: str) -> Optional[str]:
    host = urlsplit(url).hostname
    if not host:
        return None
    labels = host.split(".")
    return ".".join(labels[-2:]) if len(labels) > 2 else host


async def _scrape_page(
    page: Any,
    url: str,
    wait_after_load: int,
    timeout: int,
    check_selector: Optional[str],
    state: SecurityState,
) -> Dict[str, Any]:
    logger.info("Navigating to %s (timeout=%sms)", url, timeout)
    salvaged = False
    try:
        # `domcontentloaded` rather than `load`. Waiting for `load` means
        # waiting for every ad and tracker subresource; on commercial pages one
        # of them routinely never settles, which burned the entire navigation
        # budget and then left the DOM in a state `content()` could not
        # serialise (observed: repeatable 90s timeouts on lovehoney.com).
        # The settle delay below covers client-rendered content.
        response = await page.goto(url, wait_until=WAIT_UNTIL, timeout=timeout)
        if SETTLE_MS > 0:
            await page.wait_for_timeout(SETTLE_MS)
    except Exception:
        if state.blocked_navigation_url:
            raise InsecureConnectionError(
                state.blocked_navigation_url,
                "navigation to private/internal resource is not allowed",
            )
        # Ad-heavy commercial pages can keep the `load` event pending on a
        # subresource that never settles. If navigation never committed that is
        # a real failure; otherwise the document is already usable, and for a
        # last-resort fallback a rendered page beats a timeout.
        if page.url == "about:blank":
            raise
        logger.warning(
            "Navigation did not reach 'load' for %s; using what rendered", url
        )
        # No Response object survives a goto timeout. The document committed,
        # so report it as a normal 200 rather than "No response received".
        response = None
        salvaged = True

    await _humanize_page(page)

    if wait_after_load > 0:
        await page.wait_for_timeout(wait_after_load)

    if check_selector:
        try:
            await page.wait_for_selector(check_selector, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("Required selector not found") from exc

    # Bounded: serialising the DOM of a page that is still mutating can itself
    # hang, and a wedged call here would pin a concurrency slot.
    try:
        content = await asyncio.wait_for(page.content(), timeout=30)
    except Exception as exc:  # noqa: BLE001
        # A late same-document/client redirect can briefly invalidate the
        # execution context. Give navigation one bounded chance to settle.
        message = str(exc).lower()
        if not any(
            marker in message
            for marker in ("navigation", "execution context", "context was destroyed")
        ):
            raise
        logger.info("DOM serialization raced navigation for %s; retrying once", url)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:  # noqa: BLE001
            await page.wait_for_timeout(250)
        content = await asyncio.wait_for(page.content(), timeout=10)
    content_type: Optional[str] = None
    status: Optional[int] = None

    if response is not None:
        status = response.status
        headers = await response.all_headers()
        content_type = next(
            (v for k, v in headers.items() if k.lower() == "content-type"), None
        )
        if content_type and (
            "application/json" in content_type.lower()
            or "text/plain" in content_type.lower()
        ):
            body = await response.body()
            content = body.decode("utf-8", errors="replace")
    elif salvaged:
        status = 200

    return {"content": content, "status": status, "contentType": content_type}


async def handle_health(request: web.Request) -> web.Response:
    pool: BrowserPool = request.app["pool"]
    try:
        if not await pool.ensure_healthy():
            raise RuntimeError("browser transport is disconnected")
        return web.json_response({"status": "healthy", **pool.stats()})
    except Exception as exc:  # noqa: BLE001
        logger.error("Health check failed: %s", exc)
        return web.json_response(
            {"status": "unhealthy", "error": str(exc)}, status=503
        )


async def handle_scrape(request: web.Request) -> web.Response:
    pool: BrowserPool = request.app["pool"]

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    url = body.get("url")
    wait_after_load = int(body.get("wait_after_load") or 0)
    timeout = int(body.get("timeout") or NAVIGATION_TIMEOUT_MS)
    timeout = max(1000, min(timeout, NAVIGATION_TIMEOUT_MS))
    headers: Dict[str, str] = body.get("headers") or {}
    check_selector = body.get("check_selector")
    skip_tls_verification = bool(body.get("skip_tls_verification"))

    if not url:
        return web.json_response({"error": "URL is required"}, status=400)

    logger.info("Scrape request: url=%s timeout=%s", url, timeout)

    try:
        await assert_safe_target_url(url)
    except InsecureConnectionError as exc:
        # Matches the Playwright service: a blocked target is a 403 page result,
        # not a service error.
        return web.json_response(
            {"content": "", "pageStatusCode": 403, "pageError": str(exc)}
        )

    async with pool.semaphore:
        context = None
        page = None
        try:
            browser = await pool.get_browser()
            state = SecurityState()
            context = await browser.new_context(
                ignore_https_errors=skip_tls_verification,
                service_workers="block",
            )
            context.set_default_navigation_timeout(timeout)
            await _install_route_guard(context, state)
            page = await context.new_page()

            # A caller-supplied User-Agent is deliberately ignored: Camoufox
            # keeps UA, navigator, fonts and WebGL mutually consistent, and
            # overriding just the UA reintroduces exactly the inconsistency
            # that gets stealth browsers caught.
            extra_headers = {
                k: v
                for k, v in headers.items()
                if k.lower() not in ("user-agent", "cookie")
            }
            if "user-agent" in {k.lower() for k in headers}:
                logger.info("Ignoring caller User-Agent to preserve fingerprint coherence")

            cookie_header = next(
                (v for k, v in headers.items() if k.lower() == "cookie"), None
            )
            if cookie_header:
                domain = _cookie_domain(url)
                cookies = []
                for pair in cookie_header.split(";"):
                    pair = pair.strip()
                    if "=" not in pair:
                        continue
                    name, _, value = pair.partition("=")
                    entry = {"name": name.strip(), "value": value.strip()}
                    if domain:
                        entry.update({"domain": f".{domain}", "path": "/"})
                    else:
                        entry["url"] = url
                    cookies.append(entry)
                if cookies:
                    try:
                        await context.add_cookies(cookies)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Failed to seed cookies: %s", exc)

            if extra_headers:
                await page.set_extra_http_headers(extra_headers)

            result = await asyncio.wait_for(
                _scrape_page(
                    page, url, wait_after_load, timeout, check_selector, state
                ),
                # Hard ceiling above the navigation timeout so a wedged page
                # can never pin a concurrency slot indefinitely.
                timeout=(timeout + wait_after_load) / 1000 + 30,
            )

            page_error = get_error(result["status"])
            if page_error:
                logger.info("Scrape returned status %s (%s)", result["status"], page_error)
            else:
                logger.info("Scrape successful (%s bytes)", len(result["content"]))

            payload: Dict[str, Any] = {
                "content": result["content"],
                "pageStatusCode": result["status"],
            }
            if result["contentType"]:
                payload["contentType"] = result["contentType"]
            if page_error:
                payload["pageError"] = page_error
            return web.json_response(payload)

        except InsecureConnectionError as exc:
            return web.json_response(
                {"content": "", "pageStatusCode": 403, "pageError": str(exc)}
            )
        except asyncio.TimeoutError:
            logger.warning("Scrape timed out for %s", url)
            return web.json_response(
                {"error": "Timed out while fetching the page."}, status=504
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Scrape error for %s: %s", url, exc)
            # A dead browser process must not poison every later request.
            message = str(exc).lower()
            if any(
                marker in message
                for marker in ("target closed", "browser has been closed",
                               "connection closed", "browser closed")
            ):
                logger.warning("Browser appears to have crashed; scheduling restart")
                await pool.restart()
            return web.json_response(
                {"error": "An error occurred while fetching the page."}, status=500
            )
        finally:
            # Contexts are the unit of isolation here; leaking one leaks a
            # profile directory and its memory.
            for closeable in (page, context):
                if closeable is not None:
                    try:
                        await closeable.close()
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("Cleanup error: %s", exc)


async def handle_screenshot(request: web.Request) -> web.Response:
    """Capture a PNG of the target page.

    Not part of the Playwright service contract — that response shape has no
    field for binary data — so this is additive and nothing in the Firecrawl
    scrape path depends on it. Same SSRF policy as /scrape.
    """
    pool: BrowserPool = request.app["pool"]

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    url = body.get("url")
    wait_after_load = int(body.get("wait_after_load") or 1000)
    timeout = int(body.get("timeout") or NAVIGATION_TIMEOUT_MS)
    timeout = max(1000, min(timeout, NAVIGATION_TIMEOUT_MS))
    full_page = body.get("full_page")
    full_page = True if full_page is None else bool(full_page)

    if not url:
        return web.json_response({"error": "URL is required"}, status=400)

    try:
        await assert_safe_target_url(url)
    except InsecureConnectionError as exc:
        return web.json_response(
            {"error": str(exc), "pageStatusCode": 403}, status=403
        )

    async with pool.semaphore:
        context = None
        page = None
        try:
            browser = await pool.get_browser()
            state = SecurityState()
            context = await browser.new_context(service_workers="block")
            context.set_default_navigation_timeout(timeout)
            await _install_route_guard(context, state)
            page = await context.new_page()

            response = None
            try:
                # `domcontentloaded` rather than `load`: the load event can hang
                # well past the timeout on ad/tracker subresources, and a
                # settle delay after DOM ready is enough for a visual capture.
                response = await page.goto(
                    url, wait_until="domcontentloaded", timeout=timeout
                )
            except Exception:
                if state.blocked_navigation_url:
                    raise InsecureConnectionError(
                        state.blocked_navigation_url,
                        "navigation to private/internal resource is not allowed",
                    )
                # Still on about:blank means navigation never committed — a real
                # failure. Otherwise the event simply never fired, so capture
                # whatever did render.
                if page.url == "about:blank":
                    raise
                logger.warning(
                    "Navigation timed out but DOM committed for %s; capturing anyway",
                    url,
                )

            await _humanize_page(page)
            if wait_after_load > 0:
                await page.wait_for_timeout(wait_after_load)

            degraded = None
            try:
                image = await page.screenshot(
                    full_page=full_page, type="png", timeout=timeout
                )
            except Exception as capture_error:  # noqa: BLE001
                if not full_page:
                    raise
                # Full-page capture fails on very tall pages (Firefox surface
                # size limits, or the capture timing out under memory
                # pressure). A viewport shot beats a 500.
                logger.warning(
                    "Full-page capture failed for %s (%s); retrying viewport-only",
                    url,
                    capture_error,
                )
                image = await page.screenshot(
                    full_page=False, type="png", timeout=min(timeout, 15000)
                )
                degraded = "full-page capture failed; captured viewport only"

            payload: Dict[str, Any] = {
                "screenshot": base64.b64encode(image).decode("ascii"),
                "pageStatusCode": response.status if response is not None else 200,
                "title": await page.title(),
            }
            if degraded:
                payload["degraded"] = degraded
            logger.info("Screenshot captured for %s (%s bytes)", url, len(image))
            return web.json_response(payload)

        except InsecureConnectionError as exc:
            return web.json_response(
                {"error": str(exc), "pageStatusCode": 403}, status=403
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Screenshot failed for %s: %s", url, exc)
            message = str(exc).lower()
            if any(
                marker in message
                for marker in ("target closed", "browser has been closed",
                               "connection closed", "browser closed")
            ):
                await pool.restart()
            return web.json_response(
                {"error": "An error occurred while capturing the page."}, status=500
            )
        finally:
            for closeable in (page, context):
                if closeable is not None:
                    try:
                        await closeable.close()
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("Cleanup error: %s", exc)


async def _on_startup(app: web.Application) -> None:
    proxy = SsrfGuardProxy()
    port = await proxy.start()
    app["proxy"] = proxy
    app["pool"] = BrowserPool(proxy_port=port)


async def _on_cleanup(app: web.Application) -> None:
    pool: Optional[BrowserPool] = app.get("pool")
    if pool is not None:
        await pool.close()
    proxy: Optional[SsrfGuardProxy] = app.get("proxy")
    if proxy is not None:
        await proxy.stop()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_post("/scrape", handle_scrape)
    app.router.add_post("/screenshot", handle_screenshot)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=PORT)  # noqa: S104
