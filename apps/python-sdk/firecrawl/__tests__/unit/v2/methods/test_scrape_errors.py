from unittest.mock import Mock

import pytest

from firecrawl import DNSResolutionError, FirecrawlError, InternalServerError, TLSError
from firecrawl.v2.methods.scrape import scrape


def _client(status_code, body):
    response = Mock()
    response.status_code = status_code
    response.ok = status_code < 400
    response.headers = {}
    response.json.return_value = body
    client = Mock()
    client.post.return_value = response
    return client


def test_dns_resolution_failure_raises_dns_resolution_error():
    client = _client(200, {
        "success": False,
        "code": "SCRAPE_DNS_RESOLUTION_ERROR",
        "error": 'DNS resolution failed for hostname "nonexistent.example".',
    })

    with pytest.raises(DNSResolutionError) as exc_info:
        scrape(client, "https://nonexistent.example")

    assert exc_info.value.code == "SCRAPE_DNS_RESOLUTION_ERROR"
    assert exc_info.value.status_code == 200
    assert 'hostname "nonexistent.example"' in str(exc_info.value)


def test_tls_failure_raises_tls_error_not_internal_server_error():
    client = _client(500, {
        "success": False,
        "code": "SCRAPE_SSL_ERROR",
        "error": "An SSL/TLS certificate error occurred while trying to establish a secure connection to this website.",
    })

    with pytest.raises(TLSError) as exc_info:
        scrape(client, "https://broken-tls.example", auto_resume=False)

    assert not isinstance(exc_info.value, InternalServerError)
    assert isinstance(exc_info.value, FirecrawlError)
    assert exc_info.value.code == "SCRAPE_SSL_ERROR"
    assert "No additional error details" not in str(exc_info.value)


def test_unmapped_server_error_still_raises_internal_server_error():
    client = _client(500, {
        "success": False,
        "code": "SCRAPE_SITE_ERROR",
        "error": "The connection was reset by the peer.",
    })

    with pytest.raises(InternalServerError) as exc_info:
        scrape(client, "https://down.example", auto_resume=False)

    assert exc_info.value.code == "SCRAPE_SITE_ERROR"
