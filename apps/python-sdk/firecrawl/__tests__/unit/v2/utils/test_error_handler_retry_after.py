"""RateLimitError exposes the server-provided retry delay.

The API sends a standard ``Retry-After`` header on 429 responses so
callers can back off deterministically (issue: expose per-URL rate-limit
reset metadata on the typed SDK error). The SDK must surface it as
``RateLimitError.retry_after`` (seconds) instead of dropping it.
"""
from unittest.mock import Mock

import pytest

from firecrawl.v2.utils.error_handler import RateLimitError, handle_response_error


def _response(status_code=429, body=None, headers=None):
    response = Mock()
    response.status_code = status_code
    response.ok = status_code < 400
    response.headers = headers or {}
    response.json.return_value = body if body is not None else {"success": False, "error": "Rate limit exceeded"}
    return response


def test_retry_after_seconds_header_is_exposed():
    response = _response(headers={"Retry-After": "42"})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after == 42.0


def test_retry_after_header_parsed_case_insensitively():
    response = _response(headers={"retry-after": "7"})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after == 7.0


def test_retry_after_http_date_is_converted_to_seconds():
    from email.utils import format_datetime
    from datetime import datetime, timedelta, timezone

    retry_at = datetime.now(timezone.utc) + timedelta(seconds=90)
    response = _response(headers={"Retry-After": format_datetime(retry_at, usegmt=True)})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    # Allow generous slack for test execution time
    assert 0 < exc_info.value.retry_after <= 90


def test_missing_retry_after_header_yields_none():
    response = _response()
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after is None


def test_malformed_retry_after_header_yields_none():
    response = _response(headers={"Retry-After": "not-a-number"})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after is None


def test_negative_retry_after_yields_none():
    response = _response(headers={"Retry-After": "-5"})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after is None


def test_past_http_date_yields_zero_not_negative():
    from email.utils import format_datetime
    from datetime import datetime, timedelta, timezone

    retry_at = datetime.now(timezone.utc) - timedelta(seconds=30)
    response = _response(headers={"Retry-After": format_datetime(retry_at, usegmt=True)})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after == 0


def test_retry_after_attribute_exists_on_plain_construction():
    error = RateLimitError("rate limited")
    assert error.retry_after is None


def test_infinite_retry_after_yields_none():
    for bad in ("inf", "1e309"):
        response = _response(headers={"Retry-After": bad})
        with pytest.raises(RateLimitError) as exc_info:
            handle_response_error(response, "scrape")
        assert exc_info.value.retry_after is None


def test_out_of_range_http_date_yields_none():
    response = _response(headers={"Retry-After": "Thu, 01 Jan 99999 00:00:00 GMT"})
    with pytest.raises(RateLimitError) as exc_info:
        handle_response_error(response, "scrape")
    assert exc_info.value.retry_after is None
