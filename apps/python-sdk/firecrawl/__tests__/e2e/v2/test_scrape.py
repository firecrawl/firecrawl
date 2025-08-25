import os
import pytest
from dotenv import load_dotenv
from firecrawl import Firecrawl
import json as _json
import pytest
from firecrawl.v2.types import Viewport, ScreenshotAction, Document

load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


class TestScrapeE2E:
    """End-to-end tests for scrape functionality (v2)."""

    def setup_method(self):
        self.client = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

    def _assert_valid_document(self, doc: Document):
        assert isinstance(doc, Document)
        # At least one main content field should be present
        assert (
            (doc.markdown is not None and len(doc.markdown) > 0)
            or (doc.html is not None and len(doc.html) > 0)
            or (doc.raw_html is not None and len(doc.raw_html) > 0)
            or (doc.summary is not None and len(doc.summary) > 0)
        )
        # Metadata should exist with a source URL or title when available
        assert doc.metadata is not None

    def test_scrape_minimal(self):
        """Scrape a URL with minimal parameters and return a document."""
        doc = self.client.scrape("https://docs.firecrawl.dev")
        self._assert_valid_document(doc)

    def test_scrape_with_options_markdown(self):
        """Scrape with simple markdown format and options passed as kwargs."""
        doc = self.client.scrape(
            "https://docs.firecrawl.dev",
            formats=["markdown"],
            only_main_content=False,
            mobile=False,
        )
        self._assert_valid_document(doc)

    def test_scrape_with_screenshot_action_viewport(self):
        """Scrape with a screenshot action including viewport passed as kwargs."""
        viewport = Viewport(width=800, height=600)
        action = ScreenshotAction(full_page=False, quality=80, viewport=viewport)
        doc = self.client.scrape(
            "https://docs.firecrawl.dev",
            formats=["markdown"],
            actions=[action],
        )
        self._assert_valid_document(doc)

    @pytest.mark.parametrize("fmt,expect_field", [
        ("markdown", "markdown"),
        ("html", "html"),
        ("raw_html", "raw_html"),
        ("links", "links"),
        ("screenshot", "screenshot"),
        ("summary", "summary"),
    ])
    def test_scrape_basic_formats(self, fmt, expect_field):
        """Verify basic formats request succeeds and expected fields are present when applicable."""
        doc = self.client.scrape(
            "https://docs.firecrawl.dev",
            formats=[fmt],
        )
        # For formats that are not content (links/screenshot/json), skip main-content assertion
        if expect_field not in {"links", "screenshot"}:
            self._assert_valid_document(doc)
        if expect_field == "markdown":
            assert doc.markdown is not None
        elif expect_field == "html":
            assert doc.html is not None
        elif expect_field == "raw_html":
            assert doc.raw_html is not None
        elif expect_field == "screenshot":
            assert doc.screenshot is not None
        elif expect_field == "links":
            assert isinstance(doc.links, list)
            assert len(doc.links) > 0

    def test_scrape_with_json_format_object(self):
        """Scrape with JSON format object (requires prompt and schema)."""
        json_schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"}
            },
            "required": ["title"],
        }
        doc = self.client.scrape(
            "https://docs.firecrawl.dev",
            formats=[{"type": "json", "prompt": "Extract page title", "schema": json_schema}],
            only_main_content=True,
        )
        # JSON format may not include main content fields; ensure request succeeded
        assert isinstance(doc, Document)
        # If backend returns extracted json content, it should be present under `json`
        # (Do not fail if backend omits it; existence depends on implementation)
        # if hasattr(doc, 'json'):
        #     assert doc.json is not None

    def test_scrape_invalid_url(self):
        """Scrape should fail with empty or invalid URLs."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            self.client.scrape("")
        
        with pytest.raises(ValueError, match="URL cannot be empty"):
            self.client.scrape("   ")

    def test_scrape_with_all_params(self):
        """Comprehensive scrape using multiple formats and options."""
        json_schema = {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        }
        doc = self.client.scrape(
            "https://docs.firecrawl.dev",
            formats=[
                "markdown",
                "raw_html",
                {"type": "screenshot", "full_page": False, "quality": 70},
                {"type": "json", "prompt": "Extract title", "schema": json_schema},
                {"type": "summary" },
            ],
            headers={"User-Agent": "E2E"},
            include_tags=["main"],
            exclude_tags=["nav"],
            only_main_content=True,
            timeout=20000,
            wait_for=500,
            mobile=False,
            parsers=["pdf"],
            actions=[],
            skip_tls_verification=False,
            remove_base64_images=False,
            fast_mode=False,
            use_mock=None,
            block_ads=False,
            proxy="basic",
            max_age=0,
            store_in_cache=False,
        )
        assert isinstance(doc, Document)

    def test_scrape_images_format(self):
        """Test images format extraction."""
        doc = self.client.scrape(
            "https://firecrawl.dev",
            formats=["images"]
        )
        assert isinstance(doc, Document)
        assert doc.images is not None
        assert isinstance(doc.images, list)
        assert len(doc.images) > 0
        # Should find firecrawl logo/branding images
        assert any("firecrawl" in img.lower() or "logo" in img.lower() for img in doc.images)

    def test_scrape_images_with_multiple_formats(self):
        """Test images format works with other formats."""
        doc = self.client.scrape(
            "https://github.com",
            formats=["markdown", "links", "images"]
        )
        assert isinstance(doc, Document)
        assert doc.markdown is not None
        assert doc.links is not None  
        assert doc.images is not None
        assert isinstance(doc.images, list)
        assert len(doc.images) > 0
        
        # Images should find content not available in links format
        image_extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico']
        link_images = [
            link for link in (doc.links or [])
            if any(ext in link.lower() for ext in image_extensions)
        ]
        
        # Should discover additional images beyond those with obvious extensions
        assert len(doc.images) >= len(link_images)