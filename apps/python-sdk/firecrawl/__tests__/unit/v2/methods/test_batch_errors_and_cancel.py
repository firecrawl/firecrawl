from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods import batch as batch_module
from firecrawl.v2.methods.aio import batch as async_batch_module
from firecrawl.v2.types import CrawlErrorsResponse
from firecrawl.v2.utils.error_handler import FirecrawlError

JOB_ID = "batch-job-123"
ALREADY_COMPLETED = {"error": "Crawl is already completed"}
REQUIRES_ACTION = {
    "type": "accept_terms",
    "terms": "acme",
    "version": "2026-01-01",
    "url": "https://www.firecrawl.dev/app/alexandria/acme",
}
BATCH_ERRORS_PAYLOAD = {
    "errors": [
        {
            "id": "job-terms",
            "timestamp": "2026-11-17T00:00:00.000Z",
            "url": "https://profiles.example/person/example-person",
            "code": "THIRD_PARTY_DATA_TERMS_REQUIRED",
            "error": "An organization admin must accept the acme provider's terms.",
            "requiresAction": REQUIRES_ACTION,
        },
        {
            "id": "job-site",
            "url": "https://down.example/",
            "code": "SCRAPE_SITE_ERROR",
            "error": "The connection was reset by the peer.",
        },
    ],
    "robotsBlocked": ["https://blocked.example/private"],
}


def _sync_response(body, status_code=200):
    response = Mock()
    response.ok = status_code < 400
    response.status_code = status_code
    response.json.return_value = body
    return response


def _async_response(body, status_code=200):
    response = Mock()
    response.status_code = status_code
    response.json.return_value = body
    return response


class TestAsyncBatchScrapeErrors:
    @pytest.mark.asyncio
    async def test_parses_v2_errors_payload_without_success_field(self):
        client = AsyncMock()
        client.get.return_value = _async_response(BATCH_ERRORS_PAYLOAD)

        result = await async_batch_module.get_batch_scrape_errors(client, JOB_ID)

        client.get.assert_awaited_once_with(f"/v2/batch/scrape/{JOB_ID}/errors")
        assert isinstance(result, CrawlErrorsResponse)
        assert len(result.errors) == 2
        assert result.errors[0].id == "job-terms"
        assert result.errors[0].requires_action == REQUIRES_ACTION
        assert result.errors[1].requires_action is None
        assert result.robots_blocked == ["https://blocked.example/private"]

    @pytest.mark.asyncio
    async def test_client_and_v1_alias_return_typed_errors(self):
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client = AsyncMock()
        client.async_http_client.get.return_value = _async_response(BATCH_ERRORS_PAYLOAD)

        direct = await client.get_batch_scrape_errors(JOB_ID)
        assert isinstance(direct, CrawlErrorsResponse)
        assert direct.robots_blocked == ["https://blocked.example/private"]

        with pytest.warns(DeprecationWarning):
            compat = await client.check_batch_scrape_errors(JOB_ID)
        assert compat["success"] is True
        assert compat["robotsBlocked"] == ["https://blocked.example/private"]
        assert len(compat["errors"]) == 2

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status_code", [401, 404, 500])
    async def test_http_errors_raise_firecrawl_error(self, status_code):
        client = AsyncMock()
        client.get.return_value = _async_response(
            {"success": False, "error": "Job not found"}, status_code=status_code
        )

        with pytest.raises(FirecrawlError) as exc_info:
            await async_batch_module.get_batch_scrape_errors(client, JOB_ID)

        assert exc_info.value.status_code == status_code

    @pytest.mark.asyncio
    async def test_explicit_success_false_on_200_raises_firecrawl_error(self):
        client = AsyncMock()
        client.get.return_value = _async_response(
            {"success": False, "error": "Failed to fetch errors"}
        )

        with pytest.raises(FirecrawlError, match="Failed to fetch errors"):
            await async_batch_module.get_batch_scrape_errors(client, JOB_ID)


class TestSyncCancelBatchScrape:
    def test_returns_true_when_cancelled(self):
        client = Mock()
        client.delete.return_value = _sync_response({"status": "cancelled"})

        assert batch_module.cancel_batch_scrape(client, JOB_ID) is True
        client.delete.assert_called_once_with(f"/v2/batch/scrape/{JOB_ID}")

    def test_returns_false_when_already_completed(self):
        client = Mock()
        client.delete.return_value = _sync_response(ALREADY_COMPLETED, status_code=409)

        assert batch_module.cancel_batch_scrape(client, JOB_ID) is False

    @pytest.mark.parametrize("status_code", [401, 404, 500])
    def test_other_errors_still_raise(self, status_code):
        client = Mock()
        client.delete.return_value = _sync_response(
            {"success": False, "error": "nope"}, status_code=status_code
        )

        with pytest.raises(FirecrawlError) as exc_info:
            batch_module.cancel_batch_scrape(client, JOB_ID)

        assert exc_info.value.status_code == status_code


class TestAsyncCancelBatchScrape:
    @pytest.mark.asyncio
    async def test_returns_true_when_cancelled(self):
        client = AsyncMock()
        client.delete.return_value = _async_response({"status": "cancelled"})

        assert await async_batch_module.cancel_batch_scrape(client, JOB_ID) is True
        client.delete.assert_awaited_once_with(f"/v2/batch/scrape/{JOB_ID}")

    @pytest.mark.asyncio
    async def test_returns_false_when_already_completed(self):
        client = AsyncMock()
        client.delete.return_value = _async_response(ALREADY_COMPLETED, status_code=409)

        assert await async_batch_module.cancel_batch_scrape(client, JOB_ID) is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status_code", [401, 404, 500])
    async def test_other_errors_still_raise(self, status_code):
        client = AsyncMock()
        client.delete.return_value = _async_response(
            {"success": False, "error": "nope"}, status_code=status_code
        )

        with pytest.raises(FirecrawlError) as exc_info:
            await async_batch_module.cancel_batch_scrape(client, JOB_ID)

        assert exc_info.value.status_code == status_code
