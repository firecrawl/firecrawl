from unittest.mock import AsyncMock, Mock

import httpx
import pytest
import requests

from firecrawl.v2.methods import crawl
from firecrawl.v2.methods.aio import crawl as aio_crawl
from firecrawl.v2.types import PaginationConfig


STATUS = {
    "success": True,
    "status": "completed",
    "completed": 1,
    "total": 1,
    "creditsUsed": 2,
    "expiresAt": "2026-09-29T12:00:00Z",
    "createdAt": "2026-09-27T12:00:00Z",
    "completedAt": "2026-09-27T12:00:03Z",
    "duration": 3.0,
    "warning": "Robots.txt blocked some URLs",
    "data": [],
}


def assert_metadata(job):
    assert job.created_at.isoformat() == "2026-09-27T12:00:00+00:00"
    assert job.completed_at.isoformat() == "2026-09-27T12:00:03+00:00"
    assert job.duration == 3.0
    assert job.warning == "Robots.txt blocked some URLs"


def test_sync_crawl_status_preserves_diagnostics():
    response = requests.Response()
    response.status_code = 200
    response.json = Mock(return_value=STATUS)
    client = Mock()
    client.get.return_value = response

    assert_metadata(
        crawl.get_crawl_status(
            client, "job-id", PaginationConfig(auto_paginate=False)
        )
    )
    assert_metadata(crawl.get_crawl_status_page(client, "/v2/crawl/job-id?skip=1"))


@pytest.mark.asyncio
async def test_async_crawl_status_preserves_diagnostics():
    client = Mock()
    client.get = AsyncMock(return_value=httpx.Response(200, json=STATUS))

    assert_metadata(
        await aio_crawl.get_crawl_status(
            client, "job-id", PaginationConfig(auto_paginate=False)
        )
    )
    assert_metadata(
        await aio_crawl.get_crawl_status_page(client, "/v2/crawl/job-id?skip=1")
    )
