"""Consumer deadlines cover native WebSocket fallback and awaited status calls."""
import asyncio
from types import SimpleNamespace

import pytest
import websockets

from firecrawl.v2.watcher_async import AsyncWatcher


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["crawl", "batch"])
@pytest.mark.parametrize("slow_status", [False, True])
async def test_watch_deadline_covers_status_and_disconnect(kind, slow_status):
    async def handler(socket):
        await asyncio.sleep(0.05)
        await socket.close()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async def status(_job_id):
            if slow_status:
                await asyncio.sleep(1)
            return SimpleNamespace(status="scraping")
        client = SimpleNamespace(api_url=f"http://127.0.0.1:{port}", api_key=None,
                                 get_crawl_status=status, get_batch_scrape_status=status)
        watcher = AsyncWatcher(client, "owned", kind=kind, timeout=0.08, poll_interval=0.01)
        async def consume():
            return [snapshot async for snapshot in watcher]
        started = asyncio.get_running_loop().time()
        await asyncio.wait_for(consume(), 0.3)
        assert asyncio.get_running_loop().time() - started < 0.25


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["crawl", "batch"])
async def test_completed_status_and_caller_cancellation_are_preserved(kind):
    async def handler(socket):
        await socket.wait_closed()
    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async def complete(_job_id):
            return SimpleNamespace(status="completed")
        client = SimpleNamespace(api_url=f"http://127.0.0.1:{port}", api_key=None,
                                 get_crawl_status=complete, get_batch_scrape_status=complete)
        snapshots = [s async for s in AsyncWatcher(client, "owned", kind=kind, timeout=1)]
        assert [s.status for s in snapshots] == ["completed"]
        async def waiting(_job_id):
            await asyncio.sleep(10)
        client.get_crawl_status = client.get_batch_scrape_status = waiting
        iterator = AsyncWatcher(client, "owned", kind=kind, timeout=10).__aiter__()
        task = asyncio.create_task(iterator.__anext__())
        await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await iterator.aclose()


@pytest.mark.asyncio
async def test_producer_timeout_before_deadline_is_not_swallowed(monkeypatch):
    error = asyncio.TimeoutError("producer timeout")
    async def events(self):
        raise error
        yield  # Make this an async generator.
    monkeypatch.setattr(AsyncWatcher, "_iterate_events", events)
    watcher = AsyncWatcher(SimpleNamespace(api_url="http://localhost"), "owned", timeout=1)
    with pytest.raises(asyncio.TimeoutError) as raised:
        await watcher.__aiter__().__anext__()
    assert raised.value is error
