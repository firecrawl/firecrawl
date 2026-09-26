"""Tests for batch wait pagination fix (#4107).

When polling during wait_for_batch_completion / wait_batch_scrape, the SDK
should fetch only the status metadata (status, completed, total) without
pulling result documents, avoiding O(n) memory overhead.
"""

from __future__ import annotations

from unittest.mock import MagicMock, AsyncMock, patch

from firecrawl.v2.types import BatchScrapeJob, PaginationConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_status_response(
    status: str = "scraping",
    completed: int = 0,
    total: int = 100,
    *,
    data: list | None = None,
    next_url: str | None = None,
) -> dict:
    return {
        "success": True,
        "status": status,
        "completed": completed,
        "total": total,
        "data": data or [{"markdown": "# doc", "metadata": {"sourceURL": f"https://example.com/{i}"}} for i in range(min(total, 10))],
        "next": next_url,
    }


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._body = body

    def json(self):
        return self._body


# ---------------------------------------------------------------------------
# Sync: wait_for_batch_completion disables pagination while polling
# ---------------------------------------------------------------------------

class TestWaitBatchCompletionPagination:
    """Verify the sync wait loop passes auto_paginate=False."""

    def test_poll_uses_pagination_config(self):
        """Each poll call hits the same endpoint; assertions cover request URL and call count."""
        from firecrawl.v2.methods.batch import wait_for_batch_completion

        client = MagicMock()
        client.get = MagicMock(side_effect=[
            FakeResponse(200, _make_status_response("scraping", 0, 100)),
            FakeResponse(200, _make_status_response("scraping", 50, 100)),
            FakeResponse(200, _make_status_response("completed", 100, 100)),
            FakeResponse(200, _make_status_response("completed", 100, 100)),  # terminal re-fetch
        ])

        result = wait_for_batch_completion(client, "job-1", poll_interval=0)

        assert result.status == "completed"
        assert result.completed == 100
        # get_batch_scrape_status is called once per poll + 1 terminal re-fetch
        assert client.get.call_count == 4
        for call in client.get.call_args_list:
            assert call[0][0] == "/v2/batch/scrape/job-1"

    def test_auto_paginate_false_passed(self):
        """Intermediate polls receive PaginationConfig(auto_paginate=False); the
        terminal re-fetch uses default pagination so callers get all documents."""
        from firecrawl.v2.methods.batch import wait_for_batch_completion

        call_count = 0

        def _side_effect(client, job_id, pagination_config=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 3:
                # First three calls are intermediate polls — must carry auto_paginate=False.
                assert pagination_config is not None
                assert pagination_config.auto_paginate is False
            else:
                # Terminal re-fetch — no auto_paginate=False override.
                assert pagination_config is None
            return BatchScrapeJob(
                status="completed" if call_count >= 3 else "scraping",
                completed=call_count,
                total=3,
                data=[],
            )

        with patch("firecrawl.v2.methods.batch.get_batch_scrape_status", side_effect=_side_effect):
            client = MagicMock()
            result = wait_for_batch_completion(client, "job-1", poll_interval=0)

            assert result.status == "completed"
            assert call_count == 4  # 3 polls + 1 terminal re-fetch

    def test_failed_cancelled_no_refetch(self):
        """Failed/cancelled terminal states return immediately without re-fetch."""
        from firecrawl.v2.methods.batch import wait_for_batch_completion

        call_count = 0

        def _side_effect(client, job_id, pagination_config=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 3:
                assert pagination_config is not None
                assert pagination_config.auto_paginate is False
            else:
                # Should never reach here for failed/cancelled
                assert False, "No re-fetch expected for failed/cancelled"
            return BatchScrapeJob(
                status="failed" if call_count >= 3 else "scraping",
                completed=call_count,
                total=3,
                data=[],
            )

        with patch("firecrawl.v2.methods.batch.get_batch_scrape_status", side_effect=_side_effect):
            client = MagicMock()
            result = wait_for_batch_completion(client, "job-1", poll_interval=0)

            assert result.status == "failed"
            assert call_count == 3  # No terminal re-fetch for failed


# ---------------------------------------------------------------------------
# Async: wait_batch_scrape disables pagination while polling
# ---------------------------------------------------------------------------

import pytest


class TestAsyncWaitBatchScrapePagination:
    """Verify the async wait loop passes auto_paginate=False."""

    @pytest.mark.asyncio
    async def test_async_poll_uses_pagination_config(self):
        """Each async poll re-fetches with full pagination on terminal state."""
        from firecrawl.v2.client_async import AsyncFirecrawlClient

        app = AsyncFirecrawlClient(api_key="test-key")

        with patch("firecrawl.v2.client_async.async_batch.get_batch_scrape_status", new_callable=AsyncMock) as mock_status:
            mock_status.side_effect = [
                BatchScrapeJob(status="scraping", completed=0, total=100, data=[]),
                BatchScrapeJob(status="completed", completed=100, total=100, data=[]),
                BatchScrapeJob(status="completed", completed=100, total=100, data=[]),
            ]
            result = await app.wait_batch_scrape("job-1", poll_interval=0)

            assert result.status == "completed"
            assert mock_status.call_count == 3
            # All calls except the last (terminal re-fetch) carry auto_paginate=False.
            for call in mock_status.call_args_list[:-1]:
                _, kwargs = call
                config = kwargs.get("pagination_config")
                assert config is not None
                assert config.auto_paginate is False
            # The last call (terminal re-fetch) should use default pagination (no override).
            _, kwargs = mock_status.call_args_list[-1]
            assert kwargs.get("pagination_config") is None

    @pytest.mark.asyncio
    async def test_async_failed_cancelled_no_refetch(self):
        """Async failed/cancelled terminal states return immediately without re-fetch."""
        from firecrawl.v2.client_async import AsyncFirecrawlClient

        app = AsyncFirecrawlClient(api_key="test-key")

        call_count = 0

        async def _side_effect(client, job_id, pagination_config=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                assert pagination_config is not None
                assert pagination_config.auto_paginate is False
            else:
                assert False, "No re-fetch expected for failed/cancelled"
            return BatchScrapeJob(
                status="cancelled" if call_count >= 2 else "scraping",
                completed=call_count,
                total=2,
                data=[],
            )

        with patch("firecrawl.v2.client_async.async_batch.get_batch_scrape_status", side_effect=_side_effect):
            result = await app.wait_batch_scrape("job-1", poll_interval=0)

            assert result.status == "cancelled"
            assert call_count == 2  # No terminal re-fetch for cancelled
