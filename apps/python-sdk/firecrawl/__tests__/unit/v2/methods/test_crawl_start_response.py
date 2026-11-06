"""Unit tests for the prompt-generated options on the start crawl response."""

import asyncio
from unittest.mock import AsyncMock, Mock

from firecrawl.v2.methods import crawl as crawl_module
from firecrawl.v2.methods.aio import crawl as async_crawl_module
from firecrawl.v2.types import CrawlRequest

GENERATED = {"includePaths": ["^/blog/.*"], "limit": 50}
FINAL = {"includePaths": ["^/blog/.*"], "limit": 50, "sitemap": "include"}
BODY = {
    "success": True,
    "id": "job",
    "url": "https://api.firecrawl.dev/v2/crawl/job",
    "promptGeneratedOptions": GENERATED,
    "finalCrawlerOptions": FINAL,
}


def _response(body):
    response = Mock()
    response.ok = True
    response.status_code = 200
    response.json.return_value = body
    return response


def test_start_crawl_returns_prompt_options():
    client = Mock()
    client.post.return_value = _response(BODY)

    res = crawl_module.start_crawl(
        client, CrawlRequest(url="https://example.com", prompt="only the blog")
    )

    assert res.id == "job"
    assert res.prompt_generated_options == GENERATED
    assert res.final_crawler_options == FINAL


def test_start_crawl_without_prompt_leaves_them_unset():
    client = Mock()
    client.post.return_value = _response(
        {"success": True, "id": "job", "url": "https://api.firecrawl.dev/v2/crawl/job"}
    )

    res = crawl_module.start_crawl(client, CrawlRequest(url="https://example.com"))

    assert res.prompt_generated_options is None
    assert res.final_crawler_options is None


def test_async_start_crawl_returns_prompt_options():
    client = Mock()
    client.post = AsyncMock(return_value=_response(BODY))

    res = asyncio.run(
        async_crawl_module.start_crawl(
            client, CrawlRequest(url="https://example.com", prompt="only the blog")
        )
    )

    assert res.prompt_generated_options == GENERATED
    assert res.final_crawler_options == FINAL


def test_async_start_crawl_without_prompt_leaves_them_unset():
    client = Mock()
    client.post = AsyncMock(
        return_value=_response(
            {"success": True, "id": "job", "url": "https://api.firecrawl.dev/v2/crawl/job"}
        )
    )

    res = asyncio.run(
        async_crawl_module.start_crawl(client, CrawlRequest(url="https://example.com"))
    )

    assert res.prompt_generated_options is None
    assert res.final_crawler_options is None
