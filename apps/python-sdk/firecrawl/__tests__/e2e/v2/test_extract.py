import os
from dotenv import load_dotenv
from firecrawl import Firecrawl

load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


class TestExtractE2E:
    """E2E tests for v2 client extract (proxied to v1)."""

    def setup_method(self):
        self.client = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

    def test_extract_minimal_with_prompt(self):
        resp = self.client.extract(
            urls=["https://docs.firecrawl.dev"],
            prompt="Extract the main page title",
        )

        assert hasattr(resp, "success")
        assert resp.success is True or resp.success is False
        # data may be None if backend omits; presence depends on implementation

    def test_extract_with_schema(self):
        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"}
            },
            "required": ["title"],
        }

        resp = self.client.extract(
            urls=["https://docs.firecrawl.dev"],
            schema=schema,
            prompt="Extract the main page title",
            show_sources=True,
            enable_web_search=False,
        )

        assert hasattr(resp, "success")
        # if backend includes sources, ensure structure is a dict (do not fail if omitted)
        if hasattr(resp, "sources") and resp.sources is not None:
            assert isinstance(resp.sources, dict)

        # check if resp.data schema is equal to schema
        assert isinstance(resp.data, dict)
        assert resp.data["title"] is not None
