"""v1-style calls (params dicts, positional options, camelCase keys, dict reads) on the v2 client."""

import asyncio
import warnings
from unittest.mock import AsyncMock, patch

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl, ScrapeOptions
from firecrawl.v2.methods import scrape as scrape_module
from firecrawl.v2.types import (
    BatchScrapeJob,
    BatchScrapeResponse,
    CrawlJob,
    Document,
    DocumentMetadata,
    ScrapeOptions as V2ScrapeOptions,
)
from firecrawl.v2.utils import v1_compat


@pytest.fixture(autouse=True)
def reset_warning():
    v1_compat._warned = False
    yield
    v1_compat._warned = False


@pytest.fixture
def client():
    return Firecrawl(api_key="fc-test", api_url="http://localhost:9")


def _doc(markdown="# hi", url="https://example.com"):
    return Document(markdown=markdown, metadata=DocumentMetadata(url=url, source_url=url))


def test_scrape_url_maps_params_dict(client):
    with patch.object(client._v2_client, "scrape", return_value=_doc()) as scrape:
        result = client.scrape_url("https://example.com", params={"formats": ["markdown", "html"], "onlyMainContent": True})
    scrape.assert_called_once_with("https://example.com", formats=["markdown", "html"], only_main_content=True)
    assert result["markdown"] == "# hi"
    assert result.markdown == "# hi"
    assert result["success"] is True and result.success is True


def test_async_batch_scrape_urls_maps_positional_options(client):
    response = BatchScrapeResponse(id="job-1", url="https://api/x")
    with patch.object(client._v2_client, "start_batch_scrape", return_value=response) as start:
        job = client.async_batch_scrape_urls(["https://example.com"], {"formats": ["markdown", "links"], "onlyMainContent": True})
    start.assert_called_once_with(["https://example.com"], formats=["markdown", "links"], only_main_content=True)
    assert job["success"] is True
    assert job["id"] == "job-1"
    assert isinstance(job, BatchScrapeResponse)
    assert job.model_dump(exclude_none=True) == {"id": "job-1", "url": "https://api/x", "success": True}


def test_crawl_url_renames_v1_options(client):
    job = CrawlJob(status="completed", completed=1, total=1, data=[_doc()])
    with patch.object(client._v2_client, "crawl", return_value=job) as crawl:
        result = client.crawl_url(
            "https://example.com",
            params={"limit": 1, "maxDepth": 2, "allowBackwardLinks": True, "scrapeOptions": {"formats": ["markdown"], "waitFor": 500}},
        )
    kwargs = crawl.call_args.kwargs
    assert kwargs["limit"] == 1
    assert kwargs["max_discovery_depth"] == 2
    assert kwargs["crawl_entire_domain"] is True
    assert isinstance(kwargs["scrape_options"], V2ScrapeOptions)
    assert kwargs["scrape_options"].wait_for == 500
    assert len(result["data"]) == 1
    assert result["data"][0]["markdown"] == "# hi"
    assert result["data"][0]["metadata"]["url"] == "https://example.com"
    assert result["creditsUsed"] == 0


def test_crawl_url_accepts_2x_keyword_options(client):
    job = CrawlJob(status="completed", completed=0, total=0, data=[])
    with patch.object(client._v2_client, "crawl", return_value=job) as crawl:
        client.crawl_url(url="https://example.com", limit=2, max_depth=2, allow_backward_links=False, scrape_options=ScrapeOptions(formats=["markdown"]), poll_interval=5)
    kwargs = crawl.call_args.kwargs
    assert kwargs["max_discovery_depth"] == 2
    assert kwargs["crawl_entire_domain"] is False
    assert kwargs["poll_interval"] == 5
    assert "max_depth" not in kwargs and "allow_backward_links" not in kwargs


def test_map_url_translates_sitemap_flags(client):
    with patch.object(client._v2_client, "map", return_value=None) as map_:
        client.map_url("https://example.com", params={"ignoreSitemap": True, "includeSubdomains": True})
        client.map_url("https://example.com", params={"sitemapOnly": True})
        client.map_url("https://example.com", params={"sitemapOnly": False, "limit": 5})
    assert map_.call_args_list[0].kwargs == {"sitemap": "skip", "include_subdomains": True}
    assert map_.call_args_list[1].kwargs == {"sitemap": "only"}
    assert map_.call_args_list[2].kwargs == {"limit": 5}


def test_crawl_aliases_accept_and_drop_idempotency_key(client):
    job = CrawlJob(status="completed", completed=0, total=0, data=[])
    with patch.object(client._v2_client, "crawl", return_value=job) as crawl, patch.object(client._v2_client, "start_crawl", return_value=None) as start:
        client.crawl_url("https://example.com", params={"limit": 1}, idempotency_key="key-1")
        client.async_crawl_url("https://example.com", {"limit": 1}, idempotency_key="key-1")
    assert crawl.call_args.kwargs == {"limit": 1}
    assert start.call_args.kwargs == {"limit": 1}


def test_status_alias_results_read_like_v1(client):
    status = BatchScrapeJob(status="completed", completed=1, total=1, data=[_doc()])
    with patch.object(client._v2_client, "get_batch_scrape_status", return_value=status):
        result = client.check_batch_scrape_status("job-1")
    assert result["status"] == "completed" and result["success"] is True
    assert {p["metadata"]["url"]: p["markdown"] for p in result["data"]} == {"https://example.com": "# hi"}
    assert result.get("missing", "fallback") == "fallback"
    with pytest.raises(KeyError):
        result["missing"]


def test_scrape_options_accepts_camel_case():
    options = ScrapeOptions(formats=["html"], waitFor=1000, onlyMainContent=True, checkPromptInjection=True)
    assert isinstance(options, V2ScrapeOptions)
    assert options.wait_for == 1000
    assert options.only_main_content is True
    assert options.check_prompt_injection is True


def test_scrape_options_snake_case_does_not_warn():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        options = ScrapeOptions(formats=["markdown"], only_main_content=True)
    assert options.only_main_content is True


def test_warns_once_per_process(client):
    with patch.object(client._v2_client, "scrape", return_value=_doc()), patch.object(client._v2_client, "map", return_value=None):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            client.scrape_url("https://example.com", params={"formats": ["markdown"]})
            client.scrape_url("https://example.com")
            client.map_url("https://example.com")
            ScrapeOptions(waitFor=1)
    deprecations = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(deprecations) == 1
    assert deprecations[0].filename == __file__


def test_v2_methods_are_unchanged(client):
    with patch.object(scrape_module, "scrape", return_value=_doc()):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            doc = client.scrape("https://example.com", formats=["markdown"])
    assert type(doc) is Document
    assert "success" not in doc.model_dump()
    with pytest.raises(TypeError):
        doc["markdown"]


def test_api_url_none_uses_default():
    assert Firecrawl(api_key="fc-test", api_url=None).api_url == "https://api.firecrawl.dev"
    assert AsyncFirecrawl(api_key="fc-test", api_url=None).api_url == "https://api.firecrawl.dev"


def test_async_aliases_map_params():
    client = AsyncFirecrawl(api_key="fc-test", api_url="http://localhost:9")
    job = CrawlJob(status="completed", completed=1, total=1, data=[_doc()])
    with patch.object(client._v2_client, "crawl", new=AsyncMock(return_value=job)) as crawl:
        result = asyncio.run(client.crawl_url("https://example.com", params={"limit": 1, "scrapeOptions": {"formats": ["markdown"]}}))
    assert crawl.call_args.kwargs["url"] == "https://example.com"
    assert crawl.call_args.kwargs["limit"] == 1
    assert result["success"] is True
    assert result["data"][0]["markdown"] == "# hi"
