"""
Async local browser session methods for Firecrawl v2 API.
"""

from typing import Any, Dict

from ...types import BrowserCreateResponse, LocalBrowserDeleteResponse
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient


def _normalize_local_browser_create_response(
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    out = dict(payload)
    if "cdpUrl" in out and "cdp_url" not in out:
        out["cdp_url"] = out["cdpUrl"]
    if "expiresAt" in out and "expires_at" not in out:
        out["expires_at"] = out["expiresAt"]
    return out


async def create_local_browser(client: AsyncHttpClient) -> BrowserCreateResponse:
    """Create a new local browser session backed by the playwright microservice.

    See :meth:`firecrawl.v2.client_async.AsyncFirecrawlClient.local_browser`
    for the full usage + cleanup pattern. Summary: drive the page inside an
    ``async with async_playwright() as p:`` block and release the session
    via :func:`delete_local_browser`. Do not call ``browser.close()`` on a
    CDP-attached Playwright Browser; it terminates the remote Chromium.
    """
    resp = await client.post("/v2/local-browser", {})
    if resp.status_code >= 400:
        handle_response_error(resp, "create local browser session")
    payload = _normalize_local_browser_create_response(resp.json())
    return BrowserCreateResponse(**payload)


async def delete_local_browser(
    client: AsyncHttpClient, session_id: str
) -> LocalBrowserDeleteResponse:
    """Delete a local browser session.

    This is the authoritative cleanup path: it terminates the remote
    Chromium and releases the server-side slot. Always call it (e.g. from
    a ``finally`` block) even if your Playwright client already disconnected.
    """
    resp = await client.delete(f"/v2/local-browser/{session_id}")
    if resp.status_code >= 400:
        handle_response_error(resp, "delete local browser session")
    return LocalBrowserDeleteResponse(**resp.json())
