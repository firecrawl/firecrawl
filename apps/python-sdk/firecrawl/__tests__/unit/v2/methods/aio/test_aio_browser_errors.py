from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from firecrawl.v2.methods.aio import browser as aio_browser
from firecrawl.v2.utils.error_handler import (
    BadRequestError,
    FirecrawlError,
    RateLimitError,
    UnauthorizedError,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation, method, status, error_type",
    [
        ("create", "post", 401, UnauthorizedError),
        ("execute", "post", 429, RateLimitError),
        ("delete", "delete", 400, BadRequestError),
        ("list", "get", 404, FirecrawlError),
    ],
)
async def test_async_browser_methods_raise_api_errors(
    operation, method, status, error_type
):
    response = httpx.Response(
        status,
        json={"success": False, "error": "browser request rejected"},
        request=httpx.Request("GET", "https://api.firecrawl.dev/v2/browser"),
    )
    client = Mock()
    setattr(client, method, AsyncMock(return_value=response))

    with pytest.raises(error_type, match="browser request rejected") as exc:
        if operation == "create":
            await aio_browser.browser(client)
        elif operation == "execute":
            await aio_browser.browser_execute(client, "session-id", "print(1)")
        elif operation == "delete":
            await aio_browser.delete_browser(client, "session-id")
        else:
            await aio_browser.list_browsers(client)

    assert exc.value.status_code == status


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation, method, payload",
    [
        (
            "create",
            "post",
            {
                "success": True,
                "id": "session-id",
                "cdpUrl": "wss://browser.example/cdp",
                "liveViewUrl": "https://browser.example/live",
                "interactiveLiveViewUrl": "https://browser.example/interactive",
                "expiresAt": "2026-09-28T15:00:00Z",
            },
        ),
        (
            "execute",
            "post",
            {"success": True, "stdout": "1", "exitCode": 0},
        ),
        (
            "delete",
            "delete",
            {"success": True, "status": "destroyed", "sessionDurationMs": 1500, "creditsBilled": 1},
        ),
        (
            "list",
            "get",
            {
                "success": True,
                "sessions": [
                    {
                        "id": "session-id",
                        "status": "active",
                        "cdpUrl": "wss://browser.example/cdp",
                        "liveViewUrl": "https://browser.example/live",
                        "interactiveLiveViewUrl": "https://browser.example/interactive",
                        "streamWebView": True,
                        "createdAt": "2026-09-28T14:00:00Z",
                        "lastActivity": "2026-09-28T14:05:00Z",
                    }
                ],
            },
        ),
    ],
)
async def test_async_browser_methods_still_return_successful_responses(
    operation, method, payload
):
    response = httpx.Response(
        200,
        json=payload,
        request=httpx.Request("GET", "https://api.firecrawl.dev/v2/browser"),
    )
    client = Mock()
    setattr(client, method, AsyncMock(return_value=response))

    if operation == "create":
        result = await aio_browser.browser(client)
    elif operation == "execute":
        result = await aio_browser.browser_execute(client, "session-id", "print(1)")
    elif operation == "delete":
        result = await aio_browser.delete_browser(client, "session-id")
    else:
        result = await aio_browser.list_browsers(client)

    assert result.success is True
    if operation == "create":
        assert result.cdp_url == "wss://browser.example/cdp"
        assert result.live_view_url == "https://browser.example/live"
        assert result.interactive_live_view_url == "https://browser.example/interactive"
        assert result.expires_at == "2026-09-28T15:00:00Z"
    elif operation == "execute":
        assert result.stdout == "1"
        assert result.exit_code == 0
    elif operation == "delete":
        assert result.session_duration_ms == 1500
        assert result.credits_billed == 1
    else:
        assert len(result.sessions) == 1
        session = result.sessions[0]
        assert session.cdp_url == "wss://browser.example/cdp"
        assert session.live_view_url == "https://browser.example/live"
        assert session.interactive_live_view_url == "https://browser.example/interactive"
        assert session.stream_web_view is True
        assert session.created_at == "2026-09-28T14:00:00Z"
        assert session.last_activity == "2026-09-28T14:05:00Z"
