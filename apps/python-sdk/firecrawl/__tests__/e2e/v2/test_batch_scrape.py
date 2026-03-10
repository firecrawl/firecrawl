import os
import time
import pytest
from dotenv import load_dotenv
from firecrawl import Firecrawl
from firecrawl.v2.types import ScrapeOptions, PaginationConfig

load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


class TestBatchScrapeE2E:
    """End-to-end tests for batch scrape (v2)."""

    def setup_method(self):
        self.client = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

    def test_batch_scrape_minimal(self):
        """Start a small batch and wait for completion."""
        urls = [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ]

        job = self.client.batch_scrape(urls, formats=["markdown"], poll_interval=1, wait_timeout=120)

        assert job.status in ["completed", "failed"]
        assert job.completed >= 0
        assert job.total >= 0
        assert isinstance(job.data, list)

    def test_start_batch_minimal_and_status(self):
        """Start via start_batch_scrape (minimal), then fetch status once."""
        urls = [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ]

        start_resp = self.client.start_batch_scrape(urls, formats=["markdown"], ignore_invalid_urls=True)
        assert start_resp.id is not None
        assert start_resp.url is not None

        job = self.client.get_batch_scrape_status(start_resp.id)
        assert job.status in ["scraping", "completed", "failed"]
        assert job.total >= 0

    def test_get_batch_scrape_status_page(self):
        """Fetch a single batch scrape page using the next URL."""
        urls = [f"https://docs.firecrawl.dev?batch={i}" for i in range(15)]

        start_resp = self.client.start_batch_scrape(
            urls,
            formats=["markdown"],
            ignore_invalid_urls=True,
        )
        assert start_resp.id is not None

        pagination_config = PaginationConfig(auto_paginate=False)
        deadline = time.time() + 120
        status_job = None
        while time.time() < deadline:
            status_job = self.client.get_batch_scrape_status(
                start_resp.id,
                pagination_config=pagination_config,
            )
            if status_job.next:
                break
            if status_job.status in ["completed", "failed", "cancelled"]:
                break
            time.sleep(2)

        assert status_job is not None
        if not status_job.next:
            pytest.skip("Batch scrape completed without pagination; skipping page fetch.")

        next_page = self.client.get_batch_scrape_status_page(status_job.next)
        assert isinstance(next_page.data, list)
        assert next_page.status in ["scraping", "completed", "failed", "cancelled"]

    def test_wait_batch_with_all_params(self):
        """Blocking waiter with JSON and changeTracking formats plus many options."""
        urls = [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ]

        json_schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"}
            },
            "required": ["title"],
        }

        opts = ScrapeOptions(
            formats=[
                "markdown",
                {"type": "json", "prompt": "Extract page title", "schema": json_schema},
                {"type": "changeTracking", "prompt": "Track changes", "modes": ["json"]},
            ],
            only_main_content=True,
            mobile=False,
        )

        job = self.client.batch_scrape(
            urls,
            formats=opts.formats,
            only_main_content=opts.only_main_content,
            mobile=opts.mobile,
            ignore_invalid_urls=True,
            max_concurrency=2,
            zero_data_retention=False,
            poll_interval=1,
            wait_timeout=180,
            integration="_e2e-test",
        )

        assert job.status in ["completed", "failed"]
        assert job.completed >= 0
        assert job.total >= 0
        assert isinstance(job.data, list)

    def test_cancel_batch(self):
        """Start a batch and cancel it."""
        urls = [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ]

        start_resp = self.client.start_batch_scrape(urls, formats=["markdown"], max_concurrency=1)
        assert start_resp.id is not None

        cancelled = self.client.cancel_batch_scrape(start_resp.id)
        assert cancelled is True
