"""Envelope hints remain visible after sync/async SDK convenience methods."""
from unittest.mock import AsyncMock, Mock
from types import SimpleNamespace

import pytest

from firecrawl.v2.types import SearchRequest
from firecrawl.v2.methods.search import search
from firecrawl.v2.methods.scrape import scrape, _parse_scrape_alexandria_response
from firecrawl.v2.methods.parse import parse
from firecrawl.v2.methods.map import map as map_urls
from firecrawl.v2.methods.aio.search import search as async_search
from firecrawl.v2.methods.aio.scrape import scrape as async_scrape
from firecrawl.v2.methods.aio.parse import parse as async_parse
from firecrawl.v2.methods.aio.map import map as async_map
from firecrawl.v2.utils.error_handler import FirecrawlError, handle_response_error
from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient


HINTS = ["Inspect tool definitions before choosing a tool.", "Evaluate the result before submitting feedback."]


def response(body, status=200):
    result = Mock(status_code=status, ok=status < 400)
    result.json.return_value = body
    return result


def body():
    return {"success": True, "data": {"markdown": "# Page", "web": []}, "links": [], "agent_hints": HINTS}


@pytest.mark.parametrize("operation", ["search", "scrape", "parse", "map"])
def test_sync_hints_survive_unwrapping(operation):
    client = Mock()
    client.post.return_value = client.post_multipart.return_value = response(body())
    calls = {
        "search": lambda: search(client, SearchRequest(query="test")),
        "scrape": lambda: scrape(client, "https://example.com"),
        "parse": lambda: parse(client, b"Page", filename="page.txt"),
        "map": lambda: map_urls(client, "https://example.com"),
    }
    result = calls[operation]()
    assert result.agent_hints == HINTS
    assert result.model_dump(exclude_none=True)["agent_hints"] == HINTS
    if operation in ("scrape", "parse"):
        assert result.markdown == "# Page"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["search", "scrape", "parse", "map"])
async def test_async_hints_survive_unwrapping(operation):
    client = Mock()
    client.post = AsyncMock(return_value=response(body()))
    client.post_multipart = AsyncMock(return_value=response(body()))
    calls = {
        "search": lambda: async_search(client, SearchRequest(query="test")),
        "scrape": lambda: async_scrape(client, "https://example.com"),
        "parse": lambda: async_parse(client, b"Page", filename="page.txt"),
        "map": lambda: async_map(client, "https://example.com"),
    }
    result = await calls[operation]()
    assert result.agent_hints == HINTS


def test_alexandria_preserves_outer_hints():
    result = _parse_scrape_alexandria_response({"success": True, "agent_hints": HINTS, "data": {"alexandria": [], "creditsCost": 0}}, "request-id")
    assert result.agent_hints == HINTS
    assert result.request_id == "request-id"


@pytest.mark.asyncio
@pytest.mark.parametrize("failed", [False, True])
async def test_find_tools_convenience_methods_preserve_hints(failed):
    error = SimpleNamespace(message="Invalid options", status=400, code="invalid_option", charge_id=None) if failed else None
    result = SimpleNamespace(
        alexandria=[SimpleNamespace(error=error, data={"level": "tools", "items": [], "total": 0})],
        request_id="request-id", agent_hints=HINTS,
    )
    sync_client = FirecrawlClient(api_key="test")
    async_client = AsyncFirecrawlClient(api_key="test")
    sync_client.scrape_alexandria = Mock(return_value=result)
    async_client.scrape_alexandria = AsyncMock(return_value=result)
    if failed:
        with pytest.raises(FirecrawlError) as sync_error:
            sync_client.find_tools()
        with pytest.raises(FirecrawlError) as async_error:
            await async_client.find_tools()
        assert sync_error.value.agent_hints == async_error.value.agent_hints == HINTS
    else:
        assert sync_client.find_tools().agent_hints == HINTS
        assert (await async_client.find_tools()).agent_hints == HINTS


@pytest.mark.parametrize("value", [None, "unexpected", [123]])
def test_malformed_hints_do_not_break_search(value):
    client = Mock()
    client.post.return_value = response({"success": True, "data": {}, "agent_hints": value})
    result = search(client, SearchRequest(query="test"))
    assert result.agent_hints is None
    assert "agent_hints" not in result.model_dump(exclude_none=True)


def test_error_keeps_status_and_hints():
    with pytest.raises(FirecrawlError) as raised:
        handle_response_error(response({"success": False, "error": "Invalid request", "code": "INVALID", "agent_hints": HINTS}, 400), "search")
    assert raised.value.status_code == 400
    assert raised.value.code == "INVALID"
    assert raised.value.agent_hints == HINTS
