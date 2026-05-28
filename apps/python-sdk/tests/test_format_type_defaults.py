"""Tests for JsonFormat and ChangeTrackingFormat default type fields and serialization."""

import pytest

from firecrawl.v2.types import JsonFormat, ChangeTrackingFormat, ScrapeOptions
from firecrawl.v2.utils.validation import prepare_scrape_options


class TestJsonFormat:
    def test_defaults_type_to_json(self):
        fmt = JsonFormat(prompt="Extract titles.")
        assert fmt.type == "json"

    def test_explicit_type_json_still_works(self):
        fmt = JsonFormat(type="json", prompt="Extract titles.")
        assert fmt.type == "json"

    def test_rejects_wrong_type(self):
        with pytest.raises(Exception):
            JsonFormat(type="markdown", prompt="x")

    def test_serializes_through_prepare(self):
        opts = ScrapeOptions(formats=[JsonFormat(prompt="Extract titles.")])
        prepared = prepare_scrape_options(opts)
        fmts = prepared["formats"]
        assert any(
            isinstance(f, dict) and f.get("type") == "json" and f.get("prompt") == "Extract titles."
            for f in fmts
        )


class TestChangeTrackingFormat:
    def test_defaults_type(self):
        fmt = ChangeTrackingFormat(modes=["git-diff"])
        assert fmt.type in ("change_tracking", "changeTracking")

    def test_serializes_with_modes(self):
        opts = ScrapeOptions(formats=[ChangeTrackingFormat(modes=["git-diff"])])
        prepared = prepare_scrape_options(opts)
        fmts = prepared["formats"]
        assert fmts == [{"type": "changeTracking", "modes": ["git-diff"]}]

    def test_serializes_with_all_options(self):
        opts = ScrapeOptions(formats=[
            ChangeTrackingFormat(modes=["git-diff"], tag="daily", prompt="track changes")
        ])
        prepared = prepare_scrape_options(opts)
        fmts = prepared["formats"]
        assert fmts == [
            {"type": "changeTracking", "modes": ["git-diff"], "prompt": "track changes", "tag": "daily"}
        ]

    def test_does_not_drop_schema(self):
        opts = ScrapeOptions(formats=[
            ChangeTrackingFormat(modes=["json"], schema={"type": "object"})
        ])
        prepared = prepare_scrape_options(opts)
        fmts = prepared["formats"]
        assert fmts[0]["schema"] == {"type": "object"}
