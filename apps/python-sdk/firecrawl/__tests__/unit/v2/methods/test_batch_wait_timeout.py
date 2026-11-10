"""Batch waiters must not sleep past the wait budget or poll again after it.

Reproduces the poll-interval overshoot: wait_timeout/timeout of 1 second with
poll_interval of 2 seconds used to sleep the full interval and issue another
status request after the deadline. Time and sleep are patched, so the test
does not block on a real clock. Pagination is not part of this case.
"""

import asyncio
from unittest.mock import patch

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl

WAIT_TIMEOUT = 1
POLL_INTERVAL = 2


class _Response:
    ok = True
    status_code = 200

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


class _Clock:
    """Monotonic clock that advances only when the waiter sleeps."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += float(seconds)
        if len(self.sleeps) > 8 or self.now > 30:
            raise RuntimeError("batch waiter did not honor the timeout")


class _Transport:
    def __init__(self, clock, statuses):
        self.clock = clock
        self.statuses = list(statuses)
        self.get_count = 0
        self.get_times = []

    def _prepare_headers(self, *args, **kwargs):
        return {}

    def _start(self):
        return _Response({"success": True, "id": "job", "url": "https://example.test/job"})

    def _status(self):
        self.get_count += 1
        self.get_times.append(self.clock.now)
        if self.get_count > 8:
            raise RuntimeError("status requested too many times")
        status = self.statuses.pop(0) if self.statuses else "scraping"
        return _Response({
            "success": True,
            "status": status,
            "completed": 1 if status == "completed" else 0,
            "total": 1,
            "data": [],
        })

    def post(self, *args, **kwargs):
        return self._start()

    def get(self, *args, **kwargs):
        return self._status()


class _AsyncTransport(_Transport):
    async def post(self, *args, **kwargs):
        return self._start()

    async def get(self, *args, **kwargs):
        return self._status()


def _assert_stopped_at_deadline(clock, transport, timeout):
    assert transport.get_count == 1
    assert transport.get_times == [0.0]
    assert all(t < timeout for t in transport.get_times)
    assert clock.sleeps
    assert all(float(s) <= timeout for s in clock.sleeps)
    assert sum(float(s) for s in clock.sleeps) == timeout
    assert clock.now == timeout


def test_sync_batch_scrape_does_not_sleep_or_poll_past_wait_timeout():
    clock = _Clock()
    transport = _Transport(clock, ["scraping"])
    client = Firecrawl(api_key="fake-local-only")
    client._v2_client.http_client = transport

    with patch("firecrawl.v2.methods.batch.time.monotonic", clock.monotonic), \
            patch("firecrawl.v2.methods.batch.time.sleep", clock.sleep):
        with pytest.raises(TimeoutError):
            client.batch_scrape(
                ["https://example.test"],
                wait_timeout=WAIT_TIMEOUT,
                poll_interval=POLL_INTERVAL,
            )

    _assert_stopped_at_deadline(clock, transport, WAIT_TIMEOUT)


def test_sync_batch_scrape_returns_when_job_finishes_inside_timeout():
    clock = _Clock()
    transport = _Transport(clock, ["scraping", "completed"])
    client = Firecrawl(api_key="fake-local-only")
    client._v2_client.http_client = transport

    with patch("firecrawl.v2.methods.batch.time.monotonic", clock.monotonic), \
            patch("firecrawl.v2.methods.batch.time.sleep", clock.sleep):
        job = client.batch_scrape(
            ["https://example.test"],
            wait_timeout=5,
            poll_interval=POLL_INTERVAL,
        )

    assert job.status == "completed"
    assert transport.get_count == 2
    assert [float(s) for s in clock.sleeps] == [float(POLL_INTERVAL)]
    assert clock.now == POLL_INTERVAL
    assert all(t < 5 for t in transport.get_times)


def test_async_batch_scrape_does_not_sleep_or_poll_past_timeout():
    clock = _Clock()
    transport = _AsyncTransport(clock, ["scraping"])
    client = AsyncFirecrawl(api_key="fake-local-only")
    client._v2_client.async_http_client = transport

    async def fake_sleep(seconds):
        clock.sleep(seconds)

    async def run():
        with patch("firecrawl.v2.client_async.asyncio.get_event_loop", return_value=clock), \
                patch("firecrawl.v2.client_async.asyncio.sleep", new=fake_sleep):
            with pytest.raises(TimeoutError):
                await client.batch_scrape(
                    ["https://example.test"],
                    timeout=WAIT_TIMEOUT,
                    poll_interval=POLL_INTERVAL,
                )

    asyncio.run(run())

    _assert_stopped_at_deadline(clock, transport, WAIT_TIMEOUT)


def test_async_batch_scrape_returns_when_job_finishes_inside_timeout():
    clock = _Clock()
    transport = _AsyncTransport(clock, ["scraping", "completed"])
    client = AsyncFirecrawl(api_key="fake-local-only")
    client._v2_client.async_http_client = transport

    async def fake_sleep(seconds):
        clock.sleep(seconds)

    async def run():
        with patch("firecrawl.v2.client_async.asyncio.get_event_loop", return_value=clock), \
                patch("firecrawl.v2.client_async.asyncio.sleep", new=fake_sleep):
            return await client.batch_scrape(
                ["https://example.test"],
                timeout=5,
                poll_interval=POLL_INTERVAL,
            )

    job = asyncio.run(run())

    assert job.status == "completed"
    assert transport.get_count == 2
    assert [float(s) for s in clock.sleeps] == [float(POLL_INTERVAL)]
    assert clock.now == POLL_INTERVAL
    assert all(t < 5 for t in transport.get_times)
