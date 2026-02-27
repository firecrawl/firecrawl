"""
Tests for the Firecrawl RAGFlow connector.
"""

import json
import time
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from integrations.ragflow.config import FirecrawlSourceConfig
from integrations.ragflow.connector import FirecrawlConnector, _doc_id, _extract_title


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------

class TestFirecrawlSourceConfig:
    def test_defaults(self):
        cfg = FirecrawlSourceConfig(api_key="fc-test123")
        assert cfg.api_url == "https://api.firecrawl.dev"
        assert cfg.mode == "scrape"
        assert cfg.formats == ["markdown"]

    def test_validate_missing_key(self):
        cfg = FirecrawlSourceConfig()
        errors = cfg.validate()
        assert any("API key is required" in e for e in errors)

    def test_validate_bad_prefix(self):
        cfg = FirecrawlSourceConfig(api_key="bad-key", urls=["https://example.com"])
        errors = cfg.validate()
        assert any("fc-" in e for e in errors)

    def test_validate_ok(self):
        cfg = FirecrawlSourceConfig(api_key="fc-abc", urls=["https://example.com"])
        assert cfg.validate() == []

    def test_validate_crawl_no_url(self):
        cfg = FirecrawlSourceConfig(api_key="fc-abc", mode="crawl")
        errors = cfg.validate()
        assert any("URL is required" in e for e in errors)


# ---------------------------------------------------------------------------
# Helper tests
# ---------------------------------------------------------------------------

class TestHelpers:
    def test_doc_id_deterministic(self):
        assert _doc_id("https://a.com") == _doc_id("https://a.com")
        assert _doc_id("https://a.com") != _doc_id("https://b.com")

    def test_extract_title_from_metadata(self):
        assert _extract_title("", {"title": "Hello"}, "https://x.com") == "Hello"

    def test_extract_title_from_markdown(self):
        md = "# My Page\nSome content"
        assert _extract_title(md, {}, "https://x.com") == "My Page"

    def test_extract_title_fallback_url(self):
        assert _extract_title("", {}, "https://x.com/about") == "about"


# ---------------------------------------------------------------------------
# Connector tests
# ---------------------------------------------------------------------------

def _mock_scrape_response(url="https://example.com", title="Example"):
    return {
        "success": True,
        "data": {
            "markdown": f"# {title}\nSome content from {url}",
            "metadata": {
                "title": title,
                "sourceURL": url,
                "statusCode": 200,
            },
        },
    }


class TestFirecrawlConnector:
    def test_load_credentials(self):
        conn = FirecrawlConnector(FirecrawlSourceConfig(api_key="fc-old"))
        conn.load_credentials({"firecrawl_api_key": "fc-new"})
        assert conn.config.api_key == "fc-new"

    @patch("integrations.ragflow.connector.requests.Session")
    def test_scrape_single_url(self, MockSession):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = _mock_scrape_response()
        mock_resp.raise_for_status = MagicMock()

        session_instance = MagicMock()
        session_instance.post.return_value = mock_resp
        MockSession.return_value = session_instance

        cfg = FirecrawlSourceConfig(
            api_key="fc-test",
            urls=["https://example.com"],
            rate_limit_delay=0,
        )
        conn = FirecrawlConnector(cfg)

        batches = list(conn.load_from_state())
        assert len(batches) == 1
        docs = batches[0]
        assert len(docs) == 1
        assert docs[0].source == "firecrawl"
        assert docs[0].semantic_identifier == "Example"
        assert b"Some content" in docs[0].blob

    @patch("integrations.ragflow.connector.requests.Session")
    def test_scrape_multiple_urls(self, MockSession):
        def side_effect(*args, **kwargs):
            url = kwargs.get("json", {}).get("url", "")
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = _mock_scrape_response(url, f"Page {url}")
            resp.raise_for_status = MagicMock()
            return resp

        session_instance = MagicMock()
        session_instance.post.side_effect = side_effect
        MockSession.return_value = session_instance

        cfg = FirecrawlSourceConfig(
            api_key="fc-test",
            urls=["https://a.com", "https://b.com", "https://c.com"],
            rate_limit_delay=0,
        )
        conn = FirecrawlConnector(cfg)

        all_docs = []
        for batch in conn.load_from_state():
            all_docs.extend(batch)
        assert len(all_docs) == 3

    @patch("integrations.ragflow.connector.requests.Session")
    def test_scrape_handles_failure(self, MockSession):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": False, "error": "not found"}
        mock_resp.raise_for_status = MagicMock()

        session_instance = MagicMock()
        session_instance.post.return_value = mock_resp
        MockSession.return_value = session_instance

        cfg = FirecrawlSourceConfig(
            api_key="fc-test",
            urls=["https://bad.com"],
            rate_limit_delay=0,
        )
        conn = FirecrawlConnector(cfg)

        batches = list(conn.load_from_state())
        # failed URL produces no documents
        assert batches == []

    @patch("integrations.ragflow.connector.requests.Session")
    @patch("integrations.ragflow.connector.time.sleep", return_value=None)
    def test_crawl_mode(self, mock_sleep, MockSession):
        # First call: start crawl
        start_resp = MagicMock()
        start_resp.status_code = 200
        start_resp.json.return_value = {"success": True, "id": "job-123"}
        start_resp.raise_for_status = MagicMock()

        # Second call: poll status -> completed
        status_resp = MagicMock()
        status_resp.status_code = 200
        status_resp.json.return_value = {
            "success": True,
            "status": "completed",
            "data": [
                {
                    "markdown": "# Page 1\nContent",
                    "metadata": {"sourceURL": "https://site.com/1", "title": "Page 1", "statusCode": 200},
                },
                {
                    "markdown": "# Page 2\nMore content",
                    "metadata": {"sourceURL": "https://site.com/2", "title": "Page 2", "statusCode": 200},
                },
            ],
        }
        status_resp.raise_for_status = MagicMock()

        session_instance = MagicMock()
        session_instance.post.return_value = start_resp
        session_instance.get.return_value = status_resp
        MockSession.return_value = session_instance

        cfg = FirecrawlSourceConfig(
            api_key="fc-test",
            urls=["https://site.com"],
            mode="crawl",
            crawl_limit=10,
            rate_limit_delay=0,
        )
        conn = FirecrawlConnector(cfg)

        all_docs = []
        for batch in conn.load_from_state():
            all_docs.extend(batch)
        assert len(all_docs) == 2
        assert all_docs[0].semantic_identifier == "Page 1"

    def test_poll_source_delegates(self):
        """poll_source should delegate to load_from_state."""
        conn = FirecrawlConnector(FirecrawlSourceConfig(api_key="fc-test", urls=["https://x.com"]))
        with patch.object(conn, "load_from_state", return_value=iter([[]])) as mock_load:
            list(conn.poll_source(0, time.time()))
            mock_load.assert_called_once()
