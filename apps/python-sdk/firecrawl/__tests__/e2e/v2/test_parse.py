import os
import pytest
from dotenv import load_dotenv
from firecrawl import Firecrawl
from firecrawl.v2.types import Document, ScrapeOptions
from firecrawl.v2.utils.error_handler import FirecrawlError

load_dotenv()
API_KEY = (os.getenv("API_KEY") or "").strip()
API_URL = (os.getenv("API_URL") or "").strip()


@pytest.mark.skipif(
    not API_KEY or not API_URL,
    reason="API_KEY and API_URL are required for parse e2e tests",
)
class TestParseE2E:
    def setup_method(self):
        self.client = Firecrawl(api_key=API_KEY, api_url=API_URL)

    def test_parse_uploaded_html(self):
        doc = self.client.parse(
            b"<!DOCTYPE html><html><body><h1>Python Parse E2E</h1></body></html>",
            filename="python-parse-e2e.html",
            content_type="text/html",
            options=ScrapeOptions(formats=["markdown"]),
        )
        assert isinstance(doc, Document)
        assert doc.markdown is not None
        assert "Python Parse E2E" in doc.markdown

    def test_get_parse_formats(self):
        try:
            formats = self.client.get_parse_formats()
        except FirecrawlError as e:
            if e.status_code == 404:
                pytest.skip("GET /v2/parse/formats is not deployed on this API")
            raise
        assert len(formats) > 0
        assert any(f.format == "pdf" and f.kind == "document" for f in formats)
