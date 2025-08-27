import os
import time
from dotenv import load_dotenv
from firecrawl import Firecrawl

load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


class TestWatcherE2E:
    def setup_method(self):
        from firecrawl import Firecrawl
        self.client = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

    def test_crawl_watcher(self):
        # Start a small crawl job
        start_job = self.client.start_crawl("https://docs.firecrawl.dev", limit=2)
        job_id = start_job.id

        statuses = []
        w = self.client.watcher(job_id, kind="crawl", poll_interval=1, timeout=120)
        w.add_listener(lambda s: statuses.append(s.status))
        w.start()

        # Wait for terminal state up to 180 seconds
        deadline = time.time() + 180
        while time.time() < deadline:
            if statuses and statuses[-1] in ["completed", "failed"]:
                break
            time.sleep(1)

        w.stop()

        assert len(statuses) > 0
        assert statuses[-1] in ["completed", "failed"]

    def test_batch_watcher(self):
        urls = [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ]
        start_resp = self.client.start_batch_scrape(urls, formats=["markdown"], max_concurrency=1)
        job_id = start_resp.id

        statuses = []
        w = self.client.watcher(job_id, kind="batch", poll_interval=1, timeout=180)
        w.add_listener(lambda s: statuses.append(s.status))
        w.start()

        deadline = time.time() + 240
        while time.time() < deadline:
            if statuses and statuses[-1] in ["completed", "failed", "cancelled"]:
                break
            time.sleep(1)

        w.stop()

        assert len(statuses) > 0
        assert statuses[-1] in ["completed", "failed", "cancelled"]

