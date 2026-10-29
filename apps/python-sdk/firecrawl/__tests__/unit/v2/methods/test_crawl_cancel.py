"""
Unit tests for cancel_crawl on a finished crawl, and for async crawl()
cancelling its job when the caller's task is cancelled.
"""

import asyncio
import gc
import time
from unittest.mock import AsyncMock, Mock, patch

import pytest

import firecrawl.v2.client_async as client_async_module
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods import crawl as crawl_module
from firecrawl.v2.methods.aio import crawl as async_crawl_module
from firecrawl.v2.utils.error_handler import FirecrawlError

JOB_ID = "crawl-job-123"
ALREADY_COMPLETED = {"success": False, "error": "Crawl is already completed"}


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


def _status_body(status):
    return {
        "success": True,
        "status": status,
        "completed": 1,
        "total": 1,
        "creditsUsed": 1,
        "expiresAt": "2024-01-01T00:00:00Z",
        "next": None,
        "data": [],
    }


START_BODY = {"success": True, "id": JOB_ID, "url": f"https://api.firecrawl.dev/v2/crawl/{JOB_ID}"}


class TestSyncCancelCrawl:
    def test_returns_true_when_cancelled(self):
        client = Mock()
        client.delete.return_value = _sync_response({"status": "cancelled"})

        assert crawl_module.cancel_crawl(client, JOB_ID) is True
        client.delete.assert_called_once_with(f"/v2/crawl/{JOB_ID}")

    def test_returns_false_when_crawl_already_completed(self):
        client = Mock()
        client.delete.return_value = _sync_response(ALREADY_COMPLETED, status_code=409)

        assert crawl_module.cancel_crawl(client, JOB_ID) is False

    @pytest.mark.parametrize("status_code", [401, 404, 500])
    def test_other_errors_still_raise(self, status_code):
        client = Mock()
        client.delete.return_value = _sync_response({"success": False, "error": "nope"}, status_code=status_code)

        with pytest.raises(FirecrawlError) as exc_info:
            crawl_module.cancel_crawl(client, JOB_ID)

        assert exc_info.value.status_code == status_code


class TestAsyncCancelCrawl:
    @pytest.mark.asyncio
    async def test_returns_true_when_cancelled(self):
        client = AsyncMock()
        client.delete.return_value = _async_response({"status": "cancelled"})

        assert await async_crawl_module.cancel_crawl(client, JOB_ID) is True
        client.delete.assert_awaited_once_with(f"/v2/crawl/{JOB_ID}")

    @pytest.mark.asyncio
    async def test_returns_false_when_crawl_already_completed(self):
        client = AsyncMock()
        client.delete.return_value = _async_response(ALREADY_COMPLETED, status_code=409)

        assert await async_crawl_module.cancel_crawl(client, JOB_ID) is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status_code", [401, 404, 500])
    async def test_other_errors_still_raise(self, status_code):
        client = AsyncMock()
        client.delete.return_value = _async_response({"success": False, "error": "nope"}, status_code=status_code)

        with pytest.raises(FirecrawlError) as exc_info:
            await async_crawl_module.cancel_crawl(client, JOB_ID)

        assert exc_info.value.status_code == status_code


def _client_with_blocking_wait():
    """Return a client whose crawl starts, then blocks on the first status poll."""
    client = AsyncFirecrawlClient(api_key="fc-test")
    client.async_http_client = AsyncMock()
    client.async_http_client.post.return_value = _async_response(START_BODY)
    client.async_http_client.delete.return_value = _async_response({"status": "cancelled"})
    polling = asyncio.Event()

    async def blocking_get(*args, **kwargs):
        polling.set()
        await asyncio.Event().wait()

    client.async_http_client.get.side_effect = blocking_get
    return client, polling


class TestAsyncCrawlCancellation:
    @pytest.mark.asyncio
    async def test_task_cancel_during_wait_cancels_the_crawl(self):
        client, polling = _client_with_blocking_wait()

        task = asyncio.ensure_future(client.crawl(url="https://example.com"))
        await polling.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        client.async_http_client.delete.assert_awaited_once_with(f"/v2/crawl/{JOB_ID}")

    @pytest.mark.asyncio
    async def test_wait_for_timeout_cancels_the_crawl(self):
        client, _ = _client_with_blocking_wait()

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(client.crawl(url="https://example.com"), timeout=0.05)

        client.async_http_client.delete.assert_awaited_once_with(f"/v2/crawl/{JOB_ID}")

    @pytest.mark.asyncio
    async def test_cancel_error_does_not_mask_cancelled_error(self):
        client, polling = _client_with_blocking_wait()
        client.async_http_client.delete.side_effect = RuntimeError("network down")

        task = asyncio.ensure_future(client.crawl(url="https://example.com"))
        await polling.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        client.async_http_client.delete.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cancel_api_error_does_not_mask_cancelled_error(self):
        client, polling = _client_with_blocking_wait()
        client.async_http_client.delete.return_value = _async_response(
            {"success": False, "error": "boom"}, status_code=500
        )

        task = asyncio.ensure_future(client.crawl(url="https://example.com"))
        await polling.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        client.async_http_client.delete.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_slow_cancel_is_bounded_by_a_timeout(self):
        client, polling = _client_with_blocking_wait()

        async def hanging_delete(*args, **kwargs):
            await asyncio.Event().wait()

        client.async_http_client.delete.side_effect = hanging_delete

        with patch.object(client_async_module, "_ABANDONED_CRAWL_CANCEL_TIMEOUT", 0.01):
            task = asyncio.ensure_future(client.crawl(url="https://example.com"))
            await polling.wait()
            started = time.monotonic()
            task.cancel()

            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=5)
            elapsed = time.monotonic() - started

        client.async_http_client.delete.assert_awaited_once()
        assert elapsed < 1.0

    @pytest.mark.asyncio
    async def test_second_cancel_does_not_leave_an_unretrieved_error(self):
        client, polling = _client_with_blocking_wait()
        deleting = asyncio.Event()

        async def failing_delete(*args, **kwargs):
            deleting.set()
            await asyncio.sleep(0.05)
            raise RuntimeError("network down")

        client.async_http_client.delete.side_effect = failing_delete

        loop = asyncio.get_running_loop()
        reported = []
        previous_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: reported.append(context))
        try:
            task = asyncio.ensure_future(client.crawl(url="https://example.com"))
            await polling.wait()
            task.cancel()
            await deleting.wait()
            task.cancel()

            with pytest.raises(asyncio.CancelledError):
                await task
            del task

            # Let the background cancel fail, then collect it.
            await asyncio.sleep(0.2)
            gc.collect()
            await asyncio.sleep(0)
        finally:
            loop.set_exception_handler(previous_handler)

        client.async_http_client.delete.assert_awaited_once()
        assert reported == []

    @pytest.mark.asyncio
    async def test_cancel_before_start_returns_sends_nothing(self):
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client = AsyncMock()
        starting = asyncio.Event()

        async def blocking_post(*args, **kwargs):
            starting.set()
            await asyncio.Event().wait()

        client.async_http_client.post.side_effect = blocking_post

        task = asyncio.ensure_future(client.crawl(url="https://example.com"))
        await starting.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        client.async_http_client.delete.assert_not_called()
        client.async_http_client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_completed_crawl_sends_no_cancel(self):
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client = AsyncMock()
        client.async_http_client.post.return_value = _async_response(START_BODY)
        client.async_http_client.get.return_value = _async_response(_status_body("completed"))

        job = await client.crawl(url="https://example.com")

        assert job.id == JOB_ID
        client.async_http_client.delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_cancelled_wait_crawl_sends_no_cancel(self):
        client, polling = _client_with_blocking_wait()

        task = asyncio.ensure_future(client.wait_crawl(JOB_ID))
        await polling.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        client.async_http_client.delete.assert_not_called()
