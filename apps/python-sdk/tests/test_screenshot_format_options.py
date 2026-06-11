"""Tests that ScreenshotFormat options survive prepare_scrape_options regardless
of whether formats are passed as a ScrapeFormats object or a plain list.

Regression test for a bug where a ScreenshotFormat nested inside
ScrapeFormats(formats=[...]) was collapsed to the bare string "screenshot",
dropping full_page/quality/viewport, while the same format passed as a plain
list was serialized correctly.
"""

from firecrawl.v2.types import ScrapeOptions, ScrapeFormats, ScreenshotFormat
from firecrawl.v2.utils.validation import prepare_scrape_options


def _screenshot_entry(prepared):
    fmts = prepared["formats"]
    matches = [f for f in fmts if isinstance(f, dict) and f.get("type") == "screenshot"]
    assert len(matches) == 1, f"expected one screenshot dict, got {fmts!r}"
    return matches[0]


def test_screenshot_options_preserved_via_list():
    opts = ScrapeOptions(formats=[ScreenshotFormat(full_page=True, quality=80)])
    entry = _screenshot_entry(prepare_scrape_options(opts))
    assert entry["fullPage"] is True
    assert entry["quality"] == 80


def test_screenshot_options_preserved_via_scrape_formats():
    opts = ScrapeOptions(
        formats=ScrapeFormats(formats=[ScreenshotFormat(full_page=True, quality=80)])
    )
    entry = _screenshot_entry(prepare_scrape_options(opts))
    # Previously this lost fullPage/quality because the object was reduced to "screenshot".
    assert entry["fullPage"] is True
    assert entry["quality"] == 80


def test_screenshot_via_list_and_scrape_formats_match():
    list_entry = _screenshot_entry(
        prepare_scrape_options(ScrapeOptions(formats=[ScreenshotFormat(full_page=True, quality=80)]))
    )
    obj_entry = _screenshot_entry(
        prepare_scrape_options(
            ScrapeOptions(formats=ScrapeFormats(formats=[ScreenshotFormat(full_page=True, quality=80)]))
        )
    )
    assert list_entry == obj_entry
