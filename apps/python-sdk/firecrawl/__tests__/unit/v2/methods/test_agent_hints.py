"""Envelope hints remain visible after sync/async SDK convenience methods."""
from unittest.mock import AsyncMock, Mock
import pytest

from firecrawl.v2.types import SearchRequest
from firecrawl.v2.methods.search import search
from firecrawl.v2.methods.scrape import scrape
from firecrawl.v2.methods.parse import parse
from firecrawl.v2.methods.map import map as map_urls
from firecrawl.v2.methods.aio.search import search as async_search
from firecrawl.v2.methods.aio.scrape import scrape as async_scrape
from firecrawl.v2.methods.aio.parse import parse as async_parse
from firecrawl.v2.methods.aio.map import map as async_map
from firecrawl.v2.utils.error_handler import FirecrawlError, handle_response_error


HINTS = ["Scrape a selected search result if you need full page content.", "Evaluate the result before submitting feedback."]


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
