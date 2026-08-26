"""
Unit tests for batch scrape wait behavior on terminal states.
"""

import pytest
from unittest.mock import patch

from firecrawl.v2.types import BatchScrapeJob
from firecrawl.v2.methods import batch
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
