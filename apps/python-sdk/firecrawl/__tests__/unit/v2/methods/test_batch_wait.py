"""
Unit tests for batch scrape wait behavior on terminal states.
"""

import pytest
from unittest.mock import patch, Mock, AsyncMock

from firecrawl.v2.types import BatchScrapeJob
from firecrawl.v2.methods import batch
from firecrawl.v2.methods.aio import batch as async_batch
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.utils import JobFailedError


class TestWaitForBatchCompletion:
    def test_completed_job_is_returned(self):
        job = BatchScrapeJob(status="completed", completed=2, total=2, data=[])
        with patch.object(batch, "get_batch_scrape_status", return_value=job):
            result = batch.wait_for_batch_completion(client=None, job_id="job-1")
        assert result.status == "completed"

    def test_failed_job_raises_job_failed_error(self):
        job = BatchScrapeJob(status="failed", completed=0, total=3, data=[])
        with patch.object(batch, "get_batch_scrape_status", return_value=job):
            with pytest.raises(JobFailedError) as exc_info:
                batch.wait_for_batch_completion(client=None, job_id="job-2")
        assert exc_info.value.job.status == "failed"

    def test_cancelled_job_raises_job_failed_error(self):
        job = BatchScrapeJob(status="cancelled", completed=1, total=3, data=[])
        with patch.object(batch, "get_batch_scrape_status", return_value=job):
            with pytest.raises(JobFailedError):
                batch.wait_for_batch_completion(client=None, job_id="job-3")

    def test_job_failed_error_is_a_firecrawl_error(self):
        from firecrawl.v2.utils import FirecrawlError
        assert issubclass(JobFailedError, FirecrawlError)

    def test_kickoff_failure_raises_job_failed_error_with_api_message(self):
        """A 200 success:false status:failed response raises JobFailedError with the API error string."""
        client = Mock()
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "success": False,
            "error": "queue full",
            "status": "failed",
            "completed": 0,
            "total": 0,
            "data": [],
        }
        client.get.return_value = response

        with pytest.raises(JobFailedError) as exc_info:
            batch.wait_for_batch_completion(client, job_id="job-6")

        assert exc_info.value.job.status == "failed"
        assert "queue full" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_async_kickoff_failure_raises_job_failed_error_with_api_message(self):
        """The async waiter's kickoff-failure path also carries the API error string into JobFailedError."""
        job = BatchScrapeJob(status="failed", completed=0, total=0, data=[], error="queue full")
        client = AsyncFirecrawlClient(api_key="test", api_url="http://localhost")

        with patch.object(async_batch, "get_batch_scrape_status", new=AsyncMock(return_value=job)):
            with pytest.raises(JobFailedError) as exc_info:
                await client.wait_batch_scrape("job-7", poll_interval=1)

        assert exc_info.value.job.status == "failed"
        assert "queue full" in str(exc_info.value)
