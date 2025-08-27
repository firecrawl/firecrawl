import os
from dotenv import load_dotenv
from firecrawl import Firecrawl


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


import pytest


class TestMapE2E:
    """End-to-end tests for map functionality (v2)."""

    def setup_method(self):
        self.client = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

    def test_map_minimal_request(self):
        resp = self.client.map("https://docs.firecrawl.dev")

        assert hasattr(resp, "links") and resp.links is not None
        assert isinstance(resp.links, list)

        # Basic sanity checks on at least one link
        if len(resp.links) > 0:
            first = resp.links[0]
            assert hasattr(first, "url")
            assert isinstance(first.url, str) and first.url.startswith("http")

    @pytest.mark.parametrize(
        "sitemap",
        [
            "only",
            "skip",
            "include",
        ],
    )
    def test_map_with_options(self, sitemap):
        resp = self.client.map(
            "https://docs.firecrawl.dev",
            search="docs",
            include_subdomains=True,            limit=10,
            sitemap=sitemap,
            timeout=15000,
        )

        assert hasattr(resp, "links") and isinstance(resp.links, list)

        # Limit should be respected (server-side)
        assert len(resp.links) <= 10

        for link in resp.links:
            assert hasattr(link, "url")
            assert isinstance(link.url, str) and link.url.startswith("http")
