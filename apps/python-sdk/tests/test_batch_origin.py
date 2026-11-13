"""Tests for origin attribution parameter forwarding in batch_scrape and start_batch_scrape."""

import inspect
from unittest.mock import MagicMock

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods.aio.batch import _prepare as aio_prepare
from firecrawl.v2.methods.batch import prepare_batch_scrape_request


@pytest.fixture
def client():
    return FirecrawlClient(api_key="fc-test", api_url="http://localhost:9")


@pytest.fixture
def async_client():
    return AsyncFirecrawlClient(api_key="fc-test", api_url="http://localhost:9")


class TestBatchScrapeOrigin:
    def test_sync_start_batch_scrape_signature_accepts_origin(self):
        sig = inspect.signature(FirecrawlClient.start_batch_scrape)
        assert "origin" in sig.parameters

    def test_sync_batch_scrape_signature_accepts_origin(self):
        sig = inspect.signature(FirecrawlClient.batch_scrape)
        assert "origin" in sig.parameters

    def test_prepare_batch_scrape_request_includes_origin(self):
        urls = ["https://example.com"]
        payload = prepare_batch_scrape_request(urls, origin="langchain-integration")
        assert payload.get("origin") == "langchain-integration"

    def test_prepare_batch_scrape_request_omits_none_origin(self):
        urls = ["https://example.com"]
        payload = prepare_batch_scrape_request(urls)
        assert "origin" not in payload

    def test_async_prepare_includes_origin(self):
        urls = ["https://example.com"]
        payload = aio_prepare(urls, origin="custom-agent")
        assert payload.get("origin") == "custom-agent"

    def test_async_prepare_omits_none_origin(self):
        urls = ["https://example.com"]
        payload = aio_prepare(urls)
        assert "origin" not in payload

    def test_sync_start_batch_scrape_forwards_origin_to_post(self, client, monkeypatch):
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.json.return_value = {"success": True, "id": "job-123", "url": "https://api.firecrawl.dev/v2/batch/scrape/job-123"}
        
        captured_payload = {}

        def fake_post(endpoint, json_data, headers=None):
            captured_payload.update(json_data)
            return mock_response

        monkeypatch.setattr(client.http_client, "post", fake_post)

        res = client.start_batch_scrape(["https://example.com"], origin="python-sdk-test")
        assert res.id == "job-123"
        assert captured_payload.get("origin") == "python-sdk-test"

    @pytest.mark.asyncio
    async def test_async_start_batch_scrape_forwards_origin_to_post(self, async_client, monkeypatch):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"success": True, "id": "job-async-123", "url": "https://api.firecrawl.dev/v2/batch/scrape/job-async-123"}

        captured_payload = {}

        async def fake_post(endpoint, json_data):
            captured_payload.update(json_data)
            return mock_response

        monkeypatch.setattr(async_client.async_http_client, "post", fake_post)

        res = await async_client.start_batch_scrape(["https://example.com"], origin="async-python-test")
        assert res.id == "job-async-123"
        assert captured_payload.get("origin") == "async-python-test"

    def test_sync_batch_scrape_forwards_origin_to_post(self, client, monkeypatch):
        from firecrawl.v2.types import BatchScrapeJob

        mock_post_resp = MagicMock()
        mock_post_resp.ok = True
        mock_post_resp.json.return_value = {"success": True, "id": "job-sync-456", "url": "https://api.firecrawl.dev/v2/batch/scrape/job-sync-456"}

        captured_payload = {}

        def fake_post(endpoint, json_data, headers=None):
            captured_payload.update(json_data)
            return mock_post_resp

        def fake_get_status(c, jid):
            return BatchScrapeJob(status="completed", completed=1, total=1)

        monkeypatch.setattr(client.http_client, "post", fake_post)
        import firecrawl.v2.methods.batch as batch_mod
        monkeypatch.setattr(batch_mod, "get_batch_scrape_status", fake_get_status)

        res = client.batch_scrape(["https://example.com"], origin="python-sync-batch-scrape")
        assert res.status == "completed"
        assert captured_payload.get("origin") == "python-sync-batch-scrape"

    @pytest.mark.asyncio
    async def test_async_batch_scrape_forwards_origin_to_post(self, async_client, monkeypatch):
        from firecrawl.v2.types import BatchScrapeJob

        mock_post_resp = MagicMock()
        mock_post_resp.status_code = 200
        mock_post_resp.json.return_value = {"success": True, "id": "job-async-456", "url": "https://api.firecrawl.dev/v2/batch/scrape/job-async-456"}

        captured_payload = {}

        async def fake_post(endpoint, json_data):
            captured_payload.update(json_data)
            return mock_post_resp

        async def fake_get_status(c, jid, pagination_config=None):
            return BatchScrapeJob(status="completed", completed=1, total=1)

        monkeypatch.setattr(async_client.async_http_client, "post", fake_post)
        import firecrawl.v2.methods.aio.batch as aio_batch_mod
        monkeypatch.setattr(aio_batch_mod, "get_batch_scrape_status", fake_get_status)

        res = await async_client.batch_scrape(["https://example.com"], origin="python-async-batch-scrape")
        assert res.status == "completed"
        assert captured_payload.get("origin") == "python-async-batch-scrape"
