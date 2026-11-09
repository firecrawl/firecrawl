from unittest.mock import Mock

from firecrawl.v1.client import V1CrawlErrorsResponse
from firecrawl.v2.methods.batch import get_batch_scrape_errors
from firecrawl.v2.methods.crawl import get_crawl_errors

REQUIRES_ACTION = {
    "type": "accept_terms",
    "terms": "acme",
    "version": "2026-01-01",
    "url": "https://www.firecrawl.dev/app/alexandria/acme",
}

ERRORS = {
    "errors": [
        {
            "id": "job-terms",
            "url": "https://profiles.example/person/example-person",
            "code": "THIRD_PARTY_DATA_TERMS_REQUIRED",
            "error": "An organization admin must accept the acme provider's terms.",
            "requiresAction": REQUIRES_ACTION,
        },
        {
            "id": "job-site",
            "url": "https://down.example/",
            "code": "SCRAPE_SITE_ERROR",
            "error": "The connection was reset by the peer.",
        },
    ],
    "robotsBlocked": [],
}


def _client():
    response = Mock()
    response.ok = True
    response.json.return_value = ERRORS
    client = Mock()
    client.get.return_value = response
    return client


def test_crawl_errors_carry_requires_action():
    result = get_crawl_errors(_client(), "crawl-1")

    assert result.errors[0].requires_action == REQUIRES_ACTION
    assert result.errors[1].requires_action is None


def test_batch_scrape_errors_carry_requires_action():
    result = get_batch_scrape_errors(_client(), "batch-1")

    assert result.errors[0].requires_action == REQUIRES_ACTION
    assert result.errors[1].requires_action is None


def test_v1_crawl_errors_carry_requires_action():
    result = V1CrawlErrorsResponse(**ERRORS)

    assert result.errors[0].requiresAction == REQUIRES_ACTION
    assert result.errors[1].requiresAction is None
