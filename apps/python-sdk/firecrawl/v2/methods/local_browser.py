"""
Local browser session methods for Firecrawl v2 API.

These endpoints provision a Chromium instance inside the local
``apps/playwright-service-ts`` microservice and return a CDP URL so clients
can drive the browser with Playwright. The same session id can then be
passed to :meth:`FirecrawlClient.scrape` to read the current DOM without
re-navigation.

These endpoints are only available when the self-hosted deployment has
``PLAYWRIGHT_MICROSERVICE_URL`` configured on the API.
"""

from typing import Any, Dict

from ..types import BrowserCreateResponse, LocalBrowserDeleteResponse
from ..utils.http_client import HttpClient
from ..utils.error_handler import handle_response_error


def _normalize_local_browser_create_response(
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    out = dict(payload)
    # Accept both snake_case (server default) and camelCase for robustness.
    if "cdpUrl" in out and "cdp_url" not in out:
        out["cdp_url"] = out["cdpUrl"]
    if "expiresAt" in out and "expires_at" not in out:
        out["expires_at"] = out["expiresAt"]
    return out


def create_local_browser(client: HttpClient) -> BrowserCreateResponse:
    """Create a new local browser session backed by the playwright microservice.

    Returns:
        BrowserCreateResponse with ``id`` and ``cdp_url`` fields. Use
        ``cdp_url`` with ``playwright.chromium.connect_over_cdp`` to drive the
        browser.

    See :meth:`firecrawl.v2.client.FirecrawlClient.local_browser` for the
    full usage + cleanup pattern. Summary: drive the page inside a
    ``with sync_playwright() as p:`` block and release the session via
    :func:`delete_local_browser`. Do not call ``browser.close()`` on a
    CDP-attached Playwright Browser; it terminates the remote Chromium.
    """
    resp = client.post("/v2/local-browser", {})
    if not resp.ok:
        handle_response_error(resp, "create local browser session")
    payload = _normalize_local_browser_create_response(resp.json())
    return BrowserCreateResponse(**payload)


def delete_local_browser(
    client: HttpClient, session_id: str
) -> LocalBrowserDeleteResponse:
    """Delete a local browser session previously created with
    :func:`create_local_browser`.

    This is the authoritative cleanup path: it terminates the remote
    Chromium and releases the server-side slot. Always call it (e.g. from
    a ``finally`` block) even if your Playwright client already disconnected.

    Args:
        session_id: ID returned from ``create_local_browser``.

    Returns:
        LocalBrowserDeleteResponse with ``success`` flag.
    """
    resp = client.delete(f"/v2/local-browser/{session_id}")
    if not resp.ok:
        handle_response_error(resp, "delete local browser session")
    return LocalBrowserDeleteResponse(**resp.json())
