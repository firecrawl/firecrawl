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
@pytest.mark.parametrize("operation,method", [
    ("create", "post"),
    ("execute", "post"),
    ("delete", "delete"),
    ("list", "get"),
])
async def test_async_browser_methods_still_return_successful_responses(operation, method):
    payload = {"success": True}
    if operation == "list":
        payload["sessions"] = []
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
