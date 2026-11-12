"""AsyncFirecrawlClient.batch_scrape / start_batch_scrape take **kwargs.

These pin that flat scrape options (formats, only_main_content, ...) reach the
request body, the way they do on the sync client, instead of being dropped.
"""
import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import ScrapeOptions


def _response(body):
    response = Mock()
    response.status_code = 200
    response.json.return_value = body
    return response


def _mock_client():
    client = AsyncFirecrawlClient(api_key="fc-test")
    client.async_http_client.post = AsyncMock(
        return_value=_response({"success": True, "id": "job-1", "url": "https://api/job-1"})
    )
    client.async_http_client.get = AsyncMock(
        return_value=_response(
            {"success": True, "status": "completed", "completed": 1, "total": 1, "data": []}
        )
    )
    return client


def _sent_body(client):
    _path, body = client.async_http_client.post.call_args[0]
    return body


@pytest.mark.asyncio
async def test_start_batch_scrape_forwards_flat_scrape_options():
    client = _mock_client()

    await client.start_batch_scrape(
        ["https://example.com"],
        formats=["html"],
        only_main_content=False,
        wait_for=500,
        headers={"x-test": "1"},
        max_concurrency=2,
    )

    body = _sent_body(client)
    assert body["formats"] == ["html"]
    assert body["onlyMainContent"] is False
    assert body["waitFor"] == 500
    assert body["headers"] == {"x-test": "1"}
    assert body["maxConcurrency"] == 2


@pytest.mark.asyncio
async def test_batch_scrape_forwards_flat_scrape_options():
    client = _mock_client()

    await client.batch_scrape(
        ["https://example.com"],
        formats=["html"],
        only_main_content=False,
        poll_interval=0,
    )

    body = _sent_body(client)
    assert body["formats"] == ["html"]
    assert body["onlyMainContent"] is False


@pytest.mark.asyncio
async def test_start_batch_scrape_timeout_is_per_page_like_sync():
    """start_batch_scrape never waits, so timeout is the per-page limit, as on the sync client."""
    client = _mock_client()

    await client.start_batch_scrape(["https://example.com"], timeout=30000)

    assert _sent_body(client)["timeout"] == 30000


@pytest.mark.asyncio
async def test_batch_scrape_page_timeout_sets_per_page_limit():
    client = _mock_client()

    await client.batch_scrape(["https://example.com"], page_timeout=30000, poll_interval=0)

    assert _sent_body(client)["timeout"] == 30000


@pytest.mark.asyncio
async def test_batch_scrape_timeout_still_bounds_the_wait():
    """On the async batch_scrape waiter, timeout stays the whole-batch wait in seconds."""
    client = _mock_client()
    client.async_http_client.get = AsyncMock(
        return_value=_response(
            {"success": True, "status": "scraping", "completed": 0, "total": 1, "data": []}
        )
    )

    # The outer wait_for keeps a dropped timeout from hanging the suite; its own
    # TimeoutError has no message, so the match only passes for the SDK's error.
    with pytest.raises(TimeoutError, match="Batch wait timed out"):
        await asyncio.wait_for(
            client.batch_scrape(["https://example.com"], timeout=0.05, poll_interval=0.01),
            timeout=2,
        )

    assert "timeout" not in _sent_body(client)


@pytest.mark.asyncio
async def test_batch_scrape_forwards_every_scrape_options_field():
    client = _mock_client()

    await client.start_batch_scrape(
        ["https://example.com"],
        min_age=1000,
        redact_pii=True,
        domain_tools=True,
        tool_detail="full",
    )

    body = _sent_body(client)
    assert body["minAge"] == 1000
    assert body["redactPII"] is True
    assert body["domainTools"] is True
    assert body["toolDetail"] == "full"


@pytest.mark.asyncio
async def test_batch_level_integration_and_audit_metadata_stay_top_level():
    from firecrawl.v2.types import AuditMetadata

    client = _mock_client()

    await client.start_batch_scrape(
        ["https://example.com"],
        formats=["html"],
        integration="  zapier ",
        audit_metadata=AuditMetadata(username="alice"),
    )

    body = _sent_body(client)
    assert body["integration"] == "zapier"
    assert body["auditMetadata"] == {"username": "alice"}


@pytest.mark.asyncio
async def test_batch_scrape_page_timeout_and_wait_timeout_together():
    client = _mock_client()

    await client.batch_scrape(
        ["https://example.com"], page_timeout=30000, timeout=180, poll_interval=0
    )

    assert _sent_body(client)["timeout"] == 30000


@pytest.mark.asyncio
async def test_options_object_still_works():
    client = _mock_client()

    await client.start_batch_scrape(
        ["https://example.com"], options=ScrapeOptions(formats=["html"])
    )

    assert _sent_body(client)["formats"] == ["html"]


@pytest.mark.asyncio
async def test_options_object_and_flat_scrape_options_conflict():
    client = _mock_client()

    with pytest.raises(ValueError, match="options"):
        await client.start_batch_scrape(
            ["https://example.com"],
            options=ScrapeOptions(formats=["markdown"]),
            formats=["html"],
        )

    client.async_http_client.post.assert_not_called()


@pytest.mark.asyncio
async def test_start_batch_scrape_rejects_conflicting_timeout_and_page_timeout():
    client = _mock_client()

    with pytest.raises(ValueError, match="page_timeout"):
        await client.start_batch_scrape(
            ["https://example.com"], timeout=10000, page_timeout=30000
        )

    client.async_http_client.post.assert_not_called()


@pytest.mark.asyncio
async def test_batch_scrape_rejects_wait_timeout_with_guidance():
    """Code moved from the sync client may pass wait_timeout; say what to use instead."""
    client = _mock_client()

    with pytest.raises(TypeError, match=r"timeout=.*whole-batch wait.*page_timeout="):
        await client.batch_scrape(["https://example.com"], wait_timeout=180)

    client.async_http_client.post.assert_not_called()


@pytest.mark.asyncio
async def test_start_batch_scrape_rejects_wait_timeout_with_guidance():
    client = _mock_client()

    with pytest.raises(TypeError, match=r"does not wait.*batch_scrape\(\.\.\., timeout="):
        await client.start_batch_scrape(["https://example.com"], wait_timeout=180)

    client.async_http_client.post.assert_not_called()
