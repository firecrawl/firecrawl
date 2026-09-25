"""
Async browser session methods for Firecrawl v2 API.

Provides async create, execute, delete, and list operations for browser sessions.
"""

from typing import Any, Dict, Literal, Optional

from ...types import (
    BrowserCreateResponse,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
    BrowserListResponse,
)
from ...utils.http_client_async import AsyncHttpClient


def _normalize_browser_create_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "cdpUrl" in out and "cdp_url" not in out:
        out["cdp_url"] = out["cdpUrl"]
    if "liveViewUrl" in out and "live_view_url" not in out:
        out["live_view_url"] = out["liveViewUrl"]
    if "interactiveLiveViewUrl" in out and "interactive_live_view_url" not in out:
        out["interactive_live_view_url"] = out["interactiveLiveViewUrl"]
    if "expiresAt" in out and "expires_at" not in out:
        out["expires_at"] = out["expiresAt"]
    return out


def _normalize_browser_list_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "sessions" in out and isinstance(out["sessions"], list):
        normalized_sessions = []
        for s in out["sessions"]:
            ns = dict(s)
            if "cdpUrl" in ns and "cdp_url" not in ns:
                ns["cdp_url"] = ns["cdpUrl"]
            if "liveViewUrl" in ns and "live_view_url" not in ns:
                ns["live_view_url"] = ns["liveViewUrl"]
            if "interactiveLiveViewUrl" in ns and "interactive_live_view_url" not in ns:
                ns["interactive_live_view_url"] = ns["interactiveLiveViewUrl"]
            if "streamWebView" in ns and "stream_web_view" not in ns:
                ns["stream_web_view"] = ns["streamWebView"]
            if "createdAt" in ns and "created_at" not in ns:
                ns["created_at"] = ns["createdAt"]
            if "lastActivity" in ns and "last_activity" not in ns:
                ns["last_activity"] = ns["lastActivity"]
            normalized_sessions.append(ns)
        out["sessions"] = normalized_sessions
    return out


async def browser(
    client: AsyncHttpClient,
    *,
    ttl: Optional[int] = None,
    activity_ttl: Optional[int] = None,
    stream_web_view: Optional[bool] = None,
    profile: Optional[Dict[str, Any]] = None,
) -> BrowserCreateResponse:
    """Create a new browser session.

    Args:
        client: Async HTTP client instance
        ttl: Total time-to-live in seconds (30-3600, default 300)
        activity_ttl: Inactivity TTL in seconds (10-3600)
        stream_web_view: Whether to enable webview streaming
        profile: Profile config with ``name`` (str) and
            optional ``save_changes`` (bool, default ``True``)

    Returns:
        BrowserCreateResponse with session id and CDP URL
    """
    body: Dict[str, Any] = {}
    if ttl is not None:
        body["ttl"] = ttl
    if activity_ttl is not None:
        body["activityTtl"] = activity_ttl
    if stream_web_view is not None:
        body["streamWebView"] = stream_web_view
    if profile is not None:
        body["profile"] = {
            "name": profile["name"],
            "saveChanges": profile.get("save_changes", True),
        }

    resp = await client.post("/v2/browser", body)
    payload = _normalize_browser_create_response(resp.json())
    return BrowserCreateResponse(**payload)


def _normalize_browser_execute_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "exitCode" in out and "exit_code" not in out:
        out["exit_code"] = out["exitCode"]
    return out


def _normalize_browser_delete_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "sessionDurationMs" in out and "session_duration_ms" not in out:
        out["session_duration_ms"] = out["sessionDurationMs"]
    if "creditsBilled" in out and "credits_billed" not in out:
        out["credits_billed"] = out["creditsBilled"]
    return out


async def browser_execute(
    client: AsyncHttpClient,
    session_id: str,
    code: str,
    *,
    language: Literal["python", "node", "bash"] = "bash",
    timeout: Optional[int] = None,
) -> BrowserExecuteResponse:
    """Execute code in a browser session.

    Args:
        client: Async HTTP client instance
        session_id: Browser session ID
        code: Code to execute
        language: Programming language ("python", "node", or "bash")
        timeout: Execution timeout in seconds (1-300, default 30)

    Returns:
        BrowserExecuteResponse with execution result
    """
    body: Dict[str, Any] = {
        "code": code,
        "language": language,
    }
    if timeout is not None:
        body["timeout"] = timeout

    resp = await client.post(f"/v2/browser/{session_id}/execute", body)
    payload = _normalize_browser_execute_response(resp.json())
    return BrowserExecuteResponse(**payload)


async def delete_browser(
    client: AsyncHttpClient,
    session_id: str,
) -> BrowserDeleteResponse:
    """Delete a browser session.

    Args:
        client: Async HTTP client instance
        session_id: Browser session ID

    Returns:
        BrowserDeleteResponse
    """
    resp = await client.delete(f"/v2/browser/{session_id}")
    payload = _normalize_browser_delete_response(resp.json())
    return BrowserDeleteResponse(**payload)


async def list_browsers(
    client: AsyncHttpClient,
    *,
    status: Optional[Literal["active", "destroyed"]] = None,
) -> BrowserListResponse:
    """List browser sessions.

    Args:
        client: Async HTTP client instance
        status: Filter by session status ("active" or "destroyed")

    Returns:
        BrowserListResponse with list of sessions
    """
    endpoint = "/v2/browser"
    if status is not None:
        endpoint = f"{endpoint}?status={status}"

    resp = await client.get(endpoint)
    payload = _normalize_browser_list_response(resp.json())
    return BrowserListResponse(**payload)
