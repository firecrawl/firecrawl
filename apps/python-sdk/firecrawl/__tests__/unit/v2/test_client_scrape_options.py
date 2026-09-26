"""Regression for client wrappers silently dropping scrape options."""

from unittest.mock import MagicMock

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.types import RedactPIIOptions


def _mock_client():
    c = FirecrawlClient(api_key="test", api_url="https://api.test")
    # stub http post/ get to avoid network
    c.http_client.post = MagicMock(return_value=MagicMock(ok=True, json=lambda: {"success": True, "data": {"markdown": "hi", "metadata": {}}}))
    c.http_client.get = MagicMock(return_value=MagicMock(ok=True, json=lambda: {"success": True, "status": "completed", "data": []}))
    return c


def test_scrape_forwards_min_age_and_redact_pii():
    c = _mock_client()
    # call with the previously-dropped fields
    c.scrape("https://example.com", min_age=1000, redact_pii={"mode": "fast"}, timeout=5000)

    # inspect payload forwarded to http_client
    args, _ = c.http_client.post.call_args
    payload = args[1]
    # payload is {"url": ..., "onlyCleanContent"...} or similar? Actually scrape payload is ScrapeRequest?
    # The http_client.post receives endpoint and data; data includes scrape options flattened
    # Validation ensures minAge and redactPII are camelCased
    assert payload.get("minAge") == 1000
    assert payload.get("redactPII") == {"mode": "fast"}
    assert payload.get("timeout") == 5000


def test_scrape_forwards_redact_pii_bool():
    c = _mock_client()
    c.scrape("https://example.com", redact_pii=True)
    payload = c.http_client.post.call_args[0][1]
    assert payload.get("redactPII") is True


def test_crawl_forwards_min_age_and_redact_pii():
    c = _mock_client()
    # start_crawl builds CrawlRequest; inspect via mock
    from unittest.mock import patch

    with patch("firecrawl.v2.methods.crawl.start_crawl") as mock_start:
        mock_start.return_value = MagicMock(id="job", url="https://example.com")
        c.start_crawl("https://example.com", min_age=0, redact_pii=True, max_age=100)
        # mock was called with request containing scrape_options
        _, request = mock_start.call_args[0]
        # request is CrawlRequest, check scrape_options
        # c.start_crawl builds request from kwargs, so check first arg after http_client
        # Actually mock_start signature is (http_client, request)
        req = mock_start.call_args[0][1]
        assert req.scrape_options is not None
        assert req.scrape_options.min_age == 0
        assert req.scrape_options.redact_pii is True


def test_scrape_option_keys_includes_new_fields():
    from firecrawl.v2.client import _SCRAPE_OPTION_KEYS

    assert "min_age" in _SCRAPE_OPTION_KEYS
    assert "redact_pii" in _SCRAPE_OPTION_KEYS
