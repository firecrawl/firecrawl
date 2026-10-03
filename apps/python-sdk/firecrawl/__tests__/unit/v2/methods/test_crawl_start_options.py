from unittest.mock import AsyncMock, Mock

import httpx
import pytest
import requests

from firecrawl.v2.methods import crawl
from firecrawl.v2.methods.aio import crawl as aio_crawl
from firecrawl.v2.types import CrawlRequest


STARTED = {
    "success": True,
    "id": "crawl-id",
    "url": "https://api.firecrawl.dev/v2/crawl/crawl-id",
    "promptGeneratedOptions": {"includePaths": ["/docs/*"], "limit": 100},
    "finalCrawlerOptions": {"includePaths": ["/docs/*"], "limit": 20},
}


def assert_options(result):
    assert result.prompt_generated_options == STARTED["promptGeneratedOptions"]
    assert result.final_crawler_options == STARTED["finalCrawlerOptions"]


def test_sync_start_crawl_preserves_prompt_options():
    response = requests.Response()
    response.status_code = 200
    response.json = Mock(return_value=STARTED)
    client = Mock()
    client.post.return_value = response

    result = crawl.start_crawl(
        client, CrawlRequest(url="https://example.com", prompt="Find docs")
    )

    assert_options(result)


@pytest.mark.asyncio
async def test_async_start_crawl_preserves_prompt_options():
    client = Mock()
    client.post = AsyncMock(return_value=httpx.Response(200, json=STARTED))

    result = await aio_crawl.start_crawl(
        client, CrawlRequest(url="https://example.com", prompt="Find docs")
    )

    assert_options(result)
