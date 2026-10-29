import json
import pytest

from firecrawl.v2.types import ScrapeOptions
from firecrawl.v2.methods.aio.parse import _prepare_parse_request


class TestAsyncParseRequestPreparation:
    @pytest.mark.asyncio
    async def test_prepare_parse_request_from_bytes(self):
        options = ScrapeOptions(formats=["markdown"], only_main_content=True)
        fields, files = await _prepare_parse_request(
            b"<html><body><h1>Async Parse</h1></body></html>",
            options,
            filename="async-upload.html",
            content_type="text/html",
        )

        payload = json.loads(fields["options"])
        assert payload["formats"] == ["markdown"]
        assert payload["onlyMainContent"] is True
        assert payload["origin"].startswith("python-sdk@")

        filename, file_bytes, mime_type = files["file"]
        assert filename == "async-upload.html"
        assert b"Async Parse" in file_bytes
        assert mime_type == "text/html"

    @pytest.mark.asyncio
    async def test_prepare_parse_request_rejects_missing_path(self):
        with pytest.raises(ValueError, match="File path does not exist"):
            await _prepare_parse_request("/tmp/does-not-exist-async-upload.html")
