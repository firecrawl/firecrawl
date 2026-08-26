"""Auto-resume on processing_continues timeouts (large-PDF phase 3)."""

import asyncio
from unittest.mock import MagicMock

import pytest

from firecrawl.v2.methods import scrape as scrape_module
from firecrawl.v2.methods.aio import scrape as aio_scrape_module
from firecrawl.v2.types import ScrapeOptions
from firecrawl.v2.utils.validation import prepare_scrape_options

DOC_BODY = {"success": True, "data": {"markdown": "# big doc"}}


def _response(status_code, body, headers=None, ok=None):
    r = MagicMock()
    r.status_code = status_code
    r.ok = ok if ok is not None else status_code < 400
    r.json.return_value = body
    r.headers = headers or {}
    return r


def _processing_continues_408(retry_after_seconds=10):
    return _response(
        408,
        {
            "success": False,
            "code": "SCRAPE_TIMEOUT",
            "error": "Request timed out, but this PDF is still being processed on our side.",
            "details": {
                "state": "processing_continues",
                "jobStatus": "running",
                "retryAfterSeconds": retry_after_seconds,
            },
        },
        headers={"Retry-After": str(retry_after_seconds)},
    )


def test_resumes_and_returns_document(monkeypatch):
    sleeps = []
    monkeypatch.setattr(scrape_module.time, "sleep", sleeps.append)
    client = MagicMock()
    client.post.side_effect = [_processing_continues_408(10), _response(200, DOC_BODY)]

    doc = scrape_module.scrape(client, "https://example.com/big.pdf")

    assert doc.markdown == "# big doc"
    assert client.post.call_count == 2
    assert sleeps == [10.0]


def test_auto_resume_false_surfaces_timeout(monkeypatch):
    monkeypatch.setattr(scrape_module.time, "sleep", lambda s: pytest.fail("slept"))
    client = MagicMock()
    client.post.side_effect = [_processing_continues_408()]

    with pytest.raises(Exception):
        scrape_module.scrape(
            client, "https://example.com/big.pdf", ScrapeOptions(auto_resume=False)
        )
    assert client.post.call_count == 1


def test_auto_resume_never_reaches_payload():
    prepared = prepare_scrape_options(ScrapeOptions(auto_resume=True))
    assert prepared is not None
    assert "auto_resume" not in prepared
    assert "autoResume" not in prepared


def test_gives_up_after_attempt_bound(monkeypatch):
    sleeps = []
    monkeypatch.setattr(scrape_module.time, "sleep", sleeps.append)
    client = MagicMock()
    client.post.side_effect = [_processing_continues_408(10)] * 10

    with pytest.raises(Exception):
        scrape_module.scrape(client, "https://example.com/big.pdf")
    # 1 initial + 5 resumes.
    assert client.post.call_count == 6
    assert len(sleeps) == 5


def test_plain_timeout_does_not_resume(monkeypatch):
    monkeypatch.setattr(scrape_module.time, "sleep", lambda s: pytest.fail("slept"))
    client = MagicMock()
    client.post.side_effect = [
        _response(408, {"success": False, "code": "SCRAPE_TIMEOUT", "error": "Request timed out"})
    ]

    with pytest.raises(Exception):
        scrape_module.scrape(client, "https://example.com/slow")
    assert client.post.call_count == 1


def test_delay_clamps_and_header_fallback():
    assert scrape_module._processing_continues_delay_s(_processing_continues_408(1)) == 5
    assert scrape_module._processing_continues_delay_s(_processing_continues_408(3600)) == 600
    header_only = _processing_continues_408(0)
    body = header_only.json.return_value
    del body["details"]["retryAfterSeconds"]
    header_only.headers = {"Retry-After": "90"}
    assert scrape_module._processing_continues_delay_s(header_only) == 90
    assert scrape_module._processing_continues_delay_s(_response(500, {})) is None


def test_async_scrape_resumes(monkeypatch):
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(aio_scrape_module.asyncio, "sleep", fake_sleep)

    client = MagicMock()
    responses = [_processing_continues_408(10), _response(200, DOC_BODY)]

    async def fake_post(path, payload):
        return responses.pop(0)

    client.post = fake_post

    doc = asyncio.run(aio_scrape_module.scrape(client, "https://example.com/big.pdf"))
    assert doc.markdown == "# big doc"
    assert sleeps == [10.0]
