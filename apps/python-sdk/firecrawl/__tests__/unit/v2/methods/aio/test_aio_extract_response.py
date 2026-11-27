import asyncio
import warnings
from datetime import datetime

from firecrawl.v2.methods.aio import extract as aio_extract


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload):
        self._payload = payload

    async def get(self, path):
        return _Resp(self._payload)

    async def post(self, path, body):
        return _Resp(self._payload)


PAYLOAD = {
    "success": True,
    "id": "job-1",
    "status": "completed",
    "data": {"title": "x"},
    "expiresAt": "2026-11-03T00:00:00.000Z",
    "creditsUsed": 7,
    "tokensUsed": 1234,
}


def _assert_usage_fields(resp):
    assert resp.credits_used == 7
    assert resp.tokens_used == 1234
    assert isinstance(resp.expires_at, datetime)


class TestAioExtractResponseNormalization:
    """camelCase usage fields must populate the snake_case model fields, as in the sync client."""

    def test_get_extract_status(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            resp = asyncio.run(aio_extract.get_extract_status(_Client(PAYLOAD), "job-1"))
        _assert_usage_fields(resp)

    def test_start_extract(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            resp = asyncio.run(aio_extract.start_extract(_Client(PAYLOAD), ["https://example.com"]))
        _assert_usage_fields(resp)

    def test_extract_waits_and_keeps_usage(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            resp = asyncio.run(
                aio_extract.extract(_Client(PAYLOAD), ["https://example.com"], poll_interval=1)
            )
        _assert_usage_fields(resp)
