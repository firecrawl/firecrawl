"""The async client should reject an unknown option, the way the sync client does.

The sync methods list every option explicitly, so a misspelled one is a TypeError at the
call site. The async methods take **kwargs and pass them to a pydantic model, and pydantic
ignores unknown fields by default, so the same typo used to produce a request with default
settings and no warning.
"""

import asyncio

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient


@pytest.fixture
def clients():
    return FirecrawlClient(api_key="fc-test"), AsyncFirecrawlClient(api_key="fc-test")


def test_sync_and_async_agree_on_an_unknown_scrape_option(clients):
    sync, async_ = clients
    with pytest.raises(TypeError):
        sync.scrape("https://example.com", tiemout=5000)
    with pytest.raises(TypeError):
        asyncio.run(async_.scrape("https://example.com", tiemout=5000))


def test_unknown_search_option_raises(clients):
    _, async_ = clients
    with pytest.raises(TypeError):
        asyncio.run(async_.search("query", limitt=3))


def test_unknown_crawl_option_raises(clients):
    _, async_ = clients
    with pytest.raises(TypeError):
        asyncio.run(async_.start_crawl("https://example.com", limitt=3))


def test_unknown_batch_scrape_option_raises(clients):
    _, async_ = clients
    with pytest.raises(TypeError):
        asyncio.run(async_.start_batch_scrape(["https://example.com"], max_concurrncy=2))


def test_the_error_names_the_offending_keyword(clients):
    _, async_ = clients
    with pytest.raises(TypeError, match="tiemout"):
        asyncio.run(async_.scrape("https://example.com", tiemout=5000))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": 5000},
        {"only_main_content": True},
        {"formats": ["markdown"]},
        {"skip_tls_verification": True},
    ],
)
def test_real_scrape_options_are_still_accepted(clients, kwargs):
    """Guard against the check being too strict, which would be worse than the bug."""
    _, async_ = clients
    import firecrawl.v2.methods.aio.scrape as aio_scrape

    captured = {}

    async def fake_scrape(client, url, options=None, **_):
        captured["options"] = options

    original, aio_scrape.scrape = aio_scrape.scrape, fake_scrape
    try:
        asyncio.run(async_.scrape("https://example.com", **kwargs))
    finally:
        aio_scrape.scrape = original

    key, value = next(iter(kwargs.items()))
    assert getattr(captured["options"], key) == value


def test_crawl_still_accepts_its_polling_arguments(clients):
    """`crawl` takes poll_interval and timeout on top of the start_crawl options."""
    _, async_ = clients
    import firecrawl.v2.methods.aio.crawl as aio_crawl

    async def fake_start(client, request):
        return type("Response", (), {"id": "job-1"})()

    async def fake_status(client, job_id, **_):
        return type("Job", (), {"status": "completed"})()

    starts, statuses = aio_crawl.start_crawl, aio_crawl.get_crawl_status
    aio_crawl.start_crawl, aio_crawl.get_crawl_status = fake_start, fake_status
    try:
        job = asyncio.run(async_.crawl(url="https://example.com", limit=1, poll_interval=0))
    finally:
        aio_crawl.start_crawl, aio_crawl.get_crawl_status = starts, statuses
    assert job.status == "completed"


def test_batch_scrape_folds_flat_options_like_the_sync_client(clients):
    """Flat scrape options must reach the request, not sit in loose kwargs.

    The batch payload builder reads `options` plus a fixed key list, so a loose
    `formats=["markdown"]` was dropped and the caller got the default format.
    """
    sync, async_ = clients
    import firecrawl.v2.client as sync_mod
    import firecrawl.v2.client_async as async_mod

    captured = {}
    real_sync = sync_mod.batch_module.start_batch_scrape
    real_async = async_mod.async_batch.start_batch_scrape

    async def fake_async(client, urls, **kwargs):
        captured["async"] = kwargs

    sync_mod.batch_module.start_batch_scrape = lambda client, urls, **kw: captured.__setitem__("sync", kw)
    async_mod.async_batch.start_batch_scrape = fake_async
    try:
        kwargs = {"formats": ["markdown"], "only_main_content": True}
        sync.start_batch_scrape(["https://example.com"], **kwargs)
        asyncio.run(async_.start_batch_scrape(["https://example.com"], **kwargs))
    finally:
        sync_mod.batch_module.start_batch_scrape = real_sync
        async_mod.async_batch.start_batch_scrape = real_async

    assert captured["async"]["options"].formats == captured["sync"]["options"].formats
    assert captured["async"]["options"].only_main_content is True


def test_explicit_batch_options_win_over_flat_ones(clients):
    _, async_ = clients
    import firecrawl.v2.client_async as async_mod
    from firecrawl.v2.types import ScrapeOptions

    captured = {}

    async def fake_async(client, urls, **kwargs):
        captured.update(kwargs)

    real = async_mod.async_batch.start_batch_scrape
    async_mod.async_batch.start_batch_scrape = fake_async
    try:
        asyncio.run(
            async_.start_batch_scrape(
                ["https://example.com"],
                options=ScrapeOptions(formats=["html"]),
                only_main_content=True,
            )
        )
    finally:
        async_mod.async_batch.start_batch_scrape = real

    assert captured["options"].formats == ["html"]
    assert "only_main_content" not in captured
