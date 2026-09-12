from firecrawl.v2 import client as client_mod
from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.utils.validation import prepare_scrape_options


def test_client_scrape_sends_only_clean_content(monkeypatch):
    seen = {}

    def fake_scrape(http, url, options, auto_resume=None):
        seen["body"] = prepare_scrape_options(options)
        return object()

    monkeypatch.setattr(client_mod.scrape_module, "scrape", fake_scrape)
    FirecrawlClient(api_key="fc-test").scrape(
        "https://example.com", only_clean_content=True
    )
    assert seen["body"]["onlyCleanContent"] is True
