"""
Unit tests for the job id and warning on CrawlJob, and for CrawlJobTimeoutError.
"""

import itertools
from unittest.mock import AsyncMock, Mock, patch

import pytest

import firecrawl
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods import crawl as crawl_module
from firecrawl.v2.methods.aio import crawl as async_crawl_module
from firecrawl.v2.types import CrawlJob, CrawlRequest, PaginationConfig
from firecrawl.v2.utils import CrawlJobTimeoutError

JOB_ID = "crawl-job-123"
WARNING = "Only 1 result(s) found. For broader coverage, try crawling with crawlEntireDomain=true"
SAMPLE_DOC = {"url": "https://example.com", "markdown": "# Hello", "metadata": {"statusCode": 200}}


def _status_body(status="completed", next_url=None, warning=WARNING):
    body = {
        "success": True,
        "status": status,
        "completed": 1,
        "total": 1,
        "creditsUsed": 1,
        "expiresAt": "2024-01-01T00:00:00Z",
        "next": next_url,
        "data": [SAMPLE_DOC],
    }
    if warning is not None:
        body["warning"] = warning
    return body


def _sync_response(body):
    response = Mock()
    response.ok = True
    response.status_code = 200
    response.json.return_value = body
    return response


def _async_response(body):
    response = Mock()
    response.status_code = 200
    response.json.return_value = body
    return response


def _stepping_clock(step=10.0):
    counter = itertools.count()
    return lambda: next(counter) * step


class TestCrawlJobModel:
    def test_id_and_warning_are_optional(self):
        job = CrawlJob(status="completed")
        assert job.id is None
        assert job.warning is None


class TestSyncCrawlJobFields:
    def test_get_crawl_status_sets_id_and_warning(self):
        client = Mock()
        client.get.return_value = _sync_response(_status_body())

        job = crawl_module.get_crawl_status(client, JOB_ID)

        assert job.id == JOB_ID
        assert job.warning == WARNING

    def test_get_crawl_status_without_warning(self):
        client = Mock()
        client.get.return_value = _sync_response(_status_body(warning=None))

        job = crawl_module.get_crawl_status(client, JOB_ID)

        assert job.id == JOB_ID
        assert job.warning is None

    def test_get_crawl_status_keeps_id_and_warning_with_auto_pagination(self):
        client = Mock()
        client.get.side_effect = [
            _sync_response(_status_body(next_url=f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}?skip=1")),
            _sync_response(_status_body(warning=None)),
        ]

        job = crawl_module.get_crawl_status(client, JOB_ID, PaginationConfig(auto_paginate=True))

        assert client.get.call_count == 2
        assert len(job.data) == 2
        assert job.id == JOB_ID
        assert job.warning == WARNING

    def test_get_crawl_status_page_reads_id_from_next_url(self):
        client = Mock()
        client.get.return_value = _sync_response(_status_body())

        job = crawl_module.get_crawl_status_page(
            client, f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}?skip=10"
        )

        assert job.id == JOB_ID
        assert job.warning == WARNING

    def test_crawl_returns_job_with_id(self):
        client = Mock()
        start_response = _sync_response({"success": True, "id": JOB_ID, "url": f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}"})
        client.post.return_value = start_response
        client.get.return_value = _sync_response(_status_body())

        job = crawl_module.crawl(client, CrawlRequest(url="https://example.com"))

        assert job.id == JOB_ID
        assert job.status == "completed"
        assert job.warning == WARNING

    def test_wait_timeout_raises_crawl_job_timeout_error(self):
        client = Mock()
        client.get.return_value = _sync_response(_status_body(status="scraping"))

        with patch.object(crawl_module.time, "monotonic", side_effect=_stepping_clock()), \
                patch.object(crawl_module.time, "sleep"):
            with pytest.raises(CrawlJobTimeoutError) as exc_info:
                crawl_module.wait_for_crawl_completion(client, JOB_ID, poll_interval=1, timeout=5)

        error = exc_info.value
        assert isinstance(error, TimeoutError)
        assert error.job_id == JOB_ID
        assert error.timeout == 5
        assert str(error) == f"Crawl job {JOB_ID} did not complete within 5 seconds"

    def test_existing_timeout_error_handlers_still_catch_it(self):
        client = Mock()
        client.get.return_value = _sync_response(_status_body(status="scraping"))

        with patch.object(crawl_module.time, "monotonic", side_effect=_stepping_clock()), \
                patch.object(crawl_module.time, "sleep"):
            with pytest.raises(TimeoutError):
                crawl_module.wait_for_crawl_completion(client, JOB_ID, poll_interval=1, timeout=5)

    def test_timeout_error_survives_pickle_and_deepcopy(self):
        import copy
        import pickle

        error = CrawlJobTimeoutError(JOB_ID, 5)
        for clone in (pickle.loads(pickle.dumps(error)), copy.deepcopy(error)):
            assert isinstance(clone, CrawlJobTimeoutError)
            assert clone.job_id == JOB_ID
            assert clone.timeout == 5
            assert str(clone) == str(error)

    def test_error_is_exported_from_package_root(self):
        assert firecrawl.CrawlJobTimeoutError is CrawlJobTimeoutError


class TestAsyncCrawlJobFields:
    @pytest.mark.asyncio
    async def test_get_crawl_status_sets_id_and_warning(self):
        client = AsyncMock()
        client.get.return_value = _async_response(_status_body())

        job = await async_crawl_module.get_crawl_status(client, JOB_ID)

        assert job.id == JOB_ID
        assert job.warning == WARNING

    @pytest.mark.asyncio
    async def test_get_crawl_status_keeps_id_and_warning_with_auto_pagination(self):
        client = AsyncMock()
        client.get.side_effect = [
            _async_response(_status_body(next_url=f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}?skip=1")),
            _async_response(_status_body(warning=None)),
        ]

        job = await async_crawl_module.get_crawl_status(client, JOB_ID)

        assert client.get.call_count == 2
        assert len(job.data) == 2
        assert job.id == JOB_ID
        assert job.warning == WARNING

    @pytest.mark.asyncio
    async def test_get_crawl_status_page_reads_id_from_next_url(self):
        client = AsyncMock()
        client.get.return_value = _async_response(_status_body())

        job = await async_crawl_module.get_crawl_status_page(
            client, f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}?skip=10"
        )

        assert job.id == JOB_ID
        assert job.warning == WARNING

    @pytest.mark.asyncio
    async def test_client_crawl_returns_job_with_id(self):
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client = AsyncMock()
        client.async_http_client.post.return_value = _async_response(
            {"success": True, "id": JOB_ID, "url": f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}"}
        )
        client.async_http_client.get.return_value = _async_response(_status_body())

        job = await client.crawl(url="https://example.com")

        assert job.id == JOB_ID
        assert job.warning == WARNING

    @pytest.mark.asyncio
    async def test_wait_crawl_timeout_raises_crawl_job_timeout_error(self):
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client = AsyncMock()
        client.async_http_client.get.return_value = _async_response(_status_body(status="scraping"))

        import firecrawl.v2.client_async as client_async_module

        with patch.object(client_async_module.time, "monotonic", side_effect=_stepping_clock()), \
                patch.object(client_async_module.asyncio, "sleep", new=AsyncMock()):
            with pytest.raises(CrawlJobTimeoutError) as exc_info:
                await client.wait_crawl(JOB_ID, poll_interval=1, timeout=5)

        error = exc_info.value
        assert isinstance(error, TimeoutError)
        assert error.job_id == JOB_ID
        assert error.timeout == 5
