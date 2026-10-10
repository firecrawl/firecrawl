import asyncio
import threading
from types import SimpleNamespace

import pytest

from firecrawl.v2.watcher_async import AsyncWatcher


@pytest.mark.parametrize("proxy", [False, True])
def test_sync_status_methods_run_outside_event_loop(proxy):
    loop_thread = threading.get_ident()
    calls = []
    job = SimpleNamespace(status="completed")

    def get_crawl_status(job_id):
        calls.append((job_id, threading.get_ident()))
        return job

    status_client = SimpleNamespace(get_crawl_status=get_crawl_status)
    client = SimpleNamespace(v2=status_client) if proxy else status_client
    watcher = AsyncWatcher(client, "job")
    assert asyncio.run(watcher._fetch_job_status()) is job
    assert len(calls) == 1
    assert calls[0][0] == "job"
    assert calls[0][1] != loop_thread


@pytest.mark.parametrize("proxy", [False, True])
def test_async_status_methods_still_run_on_event_loop(proxy):
    loop_thread = threading.get_ident()
    calls = []
    job = SimpleNamespace(status="completed")

    async def get_batch_scrape_status(job_id):
        calls.append((job_id, threading.get_ident()))
        return job

    status_client = SimpleNamespace(get_batch_scrape_status=get_batch_scrape_status)
    client = SimpleNamespace(v2=status_client) if proxy else status_client
    watcher = AsyncWatcher(client, "job", kind="batch")
    assert asyncio.run(watcher._fetch_job_status()) is job
    assert calls == [("job", loop_thread)]


def test_sync_factory_returning_awaitable_is_awaited():
    async def get_job():
        return "job result"

    client = SimpleNamespace(get_crawl_status=lambda job_id: get_job())
    assert asyncio.run(AsyncWatcher(client, "job")._fetch_job_status()) == "job result"


def test_sync_type_error_is_propagated_without_repeating_request():
    calls = []

    def get_crawl_status(job_id):
        calls.append(job_id)
        raise TypeError("invalid response")

    with pytest.raises(TypeError, match="invalid response"):
        asyncio.run(AsyncWatcher(SimpleNamespace(get_crawl_status=get_crawl_status), "job")._fetch_job_status())
    assert calls == ["job"]
