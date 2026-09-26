"""Async batch start should forward idempotency_key as header."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from firecrawl.v2.methods.aio.batch import start_batch_scrape


@pytest.mark.asyncio
async def test_async_batch_idempotency_key_forwarded():
    client = MagicMock()
    client._headers = MagicMock(return_value={"x-idempotency-key": "k123"})
    mock_resp = MagicMock(status_code=200, json=lambda: {"success": True, "id": "job", "url": "u", "invalidURLs": []})
    client.post = AsyncMock(return_value=mock_resp)

    await start_batch_scrape(client, ["https://example.com"], idempotency_key="k123")

    client._headers.assert_called_once_with("k123")
    client.post.assert_awaited_once()
    args, kwargs = client.post.call_args
    # Verify headers were passed with the idempotency key
    called_headers = kwargs.get("headers")
    assert called_headers is not None
    assert called_headers.get("x-idempotency-key") == "k123"


@pytest.mark.asyncio
async def test_async_batch_without_idempotency_no_header():
    client = MagicMock()
    mock_resp = MagicMock(status_code=200, json=lambda: {"success": True, "id": "job", "url": "u", "invalidURLs": []})
    client.post = AsyncMock(return_value=mock_resp)

    await start_batch_scrape(client, ["https://example.com"])

    # _headers should not be called when no idempotency_key is provided
    assert not hasattr(client, '_headers') or not client._headers.called or len(client._headers.call_args_list) == 0
    # The post call should not have headers kwarg (or headers should not contain idempotency key)
    client.post.assert_awaited_once()
    args, kwargs = client.post.call_args
    called_headers = kwargs.get("headers")
    assert called_headers is None or "x-idempotency-key" not in called_headers
