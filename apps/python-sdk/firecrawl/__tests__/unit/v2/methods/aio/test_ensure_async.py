import asyncio
import time
import httpx
import pytest

from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.methods.aio import batch as aio_batch


@pytest.mark.asyncio
async def test_scrape_concurrency(monkeypatch):
    async def fake_post(self, endpoint, data, headers=None, timeout=None):
        await asyncio.sleep(0.1)
        return httpx.Response(200, json={"success": True, "data": {}})

    monkeypatch.setattr(AsyncHttpClient, "post", fake_post)

    client = AsyncFirecrawlClient(api_key="test", api_url="http://localhost")

    start = time.perf_counter()
    await asyncio.gather(
        client.scrape("https://firecrawl.dev"),
        client.scrape("https://firecrawl.dev"),
        client.scrape("https://firecrawl.dev")
    )
    elapsed = time.perf_counter() - start

    # If calls run concurrently, total should be close to single 0.1s delay, not 0.3s
    assert elapsed < 0.25


@pytest.mark.asyncio
async def test_event_loop_not_blocked(monkeypatch):
    ticks = 0

    async def ticker():
        nonlocal ticks
        for _ in range(5):
            await asyncio.sleep(0.05)
            ticks += 1

    async def fake_post(self, endpoint, data, headers=None, timeout=None):
        await asyncio.sleep(0.2)
        return httpx.Response(200, json={"success": True, "data": {}})

    monkeypatch.setattr(AsyncHttpClient, "post", fake_post)

    client = AsyncFirecrawlClient(api_key="test", api_url="http://localhost")

    await asyncio.gather(ticker(), client.scrape("https://a"))
    # If scrape awaited properly, ticker should have progressed several steps
    assert ticks >= 3


@pytest.mark.asyncio
async def test_wait_batch_scrape_polling_interval(monkeypatch):
    # Simulate one scraping status then completed
    class S:  # simple status holder
        def __init__(self, status):
            self.status = status

    states = ["scraping", "completed"]

    async def fake_status(client, job_id):
        state = states.pop(0)
        return S(state)

    monkeypatch.setattr(aio_batch, "get_batch_scrape_status", fake_status)

    client = AsyncFirecrawlClient(api_key="test", api_url="http://localhost")

    start = time.perf_counter()
    await client.wait_batch_scrape("job-1", poll_interval=0.1, timeout=2)
    elapsed = time.perf_counter() - start

    # Should take roughly one poll interval to reach completed
    assert 0.09 <= elapsed <= 0.5


@pytest.mark.asyncio
async def test_async_transport_used_no_threads(monkeypatch):
    # Make any to_thread usage blow up
    monkeypatch.setattr(asyncio, "to_thread", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("to_thread not allowed")))
    # Make sync HttpClient unusable
    def _boom(*a, **k):
        raise RuntimeError("sync client should not be used")
    monkeypatch.setattr(HttpClient, "post", _boom)
    monkeypatch.setattr(HttpClient, "get", _boom)
    monkeypatch.setattr(HttpClient, "delete", _boom)

    # Track true async concurrency
    active = 0
    max_active = 0
    async def fake_post(self, endpoint, data, headers=None, timeout=None):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        try:
            await asyncio.sleep(0.1)
            return httpx.Response(200, json={"success": True, "data": {}})
        finally:
            active -= 1

    monkeypatch.setattr(AsyncHttpClient, "post", fake_post)

    client = AsyncFirecrawlClient(api_key="test", api_url="http://localhost")

    await asyncio.gather(
        client.scrape("https://firecrawl.dev"),
        client.scrape("https://firecrawl.dev"),
        client.search("q"),  # uses async search
    )

    assert max_active >= 2

