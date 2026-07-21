import json
import pytest

from firecrawl.v2.types import ParseOptions
from firecrawl.v2.methods.parse import _prepare_parse_request


class TestParseRequestPreparation:
    def test_prepare_parse_request_from_bytes(self):
        options = ParseOptions(
            formats=["markdown"],
            only_main_content=False,
            integration="  parse-unit  ",
        )

        fields, files = _prepare_parse_request(
            b"<html><body><h1>Parse</h1></body></html>",
            options,
            filename="upload.html",
            content_type="text/html",
        )

        assert "options" in fields
        payload = json.loads(fields["options"])
        assert payload["formats"] == ["markdown"]
        assert payload["onlyMainContent"] is False
        assert payload["integration"] == "parse-unit"
        assert payload["origin"].startswith("python-sdk@")
        assert "maxAge" not in payload
        assert "storeInCache" not in payload
        assert "lockdown" not in payload

        assert "file" in files
        filename, file_bytes, mime_type = files["file"]
        assert filename == "upload.html"
        assert file_bytes.startswith(b"<html>")
        assert mime_type == "text/html"

    def test_prepare_parse_request_from_file_path(self, tmp_path):
        file_path = tmp_path / "sample.html"
        file_path.write_text("<html><body>Path Upload</body></html>")

        fields, files = _prepare_parse_request(str(file_path))

        payload = json.loads(fields["options"])
        assert payload["origin"].startswith("python-sdk@")
        assert payload.get("formats") is None

        filename, file_bytes, mime_type = files["file"]
        assert filename == "sample.html"
        assert b"Path Upload" in file_bytes
        assert mime_type == "text/html"

    def test_prepare_parse_request_rejects_missing_path(self, tmp_path):
        missing_file = tmp_path / "missing-upload-file.html"
        with pytest.raises(ValueError, match="File path does not exist"):
            _prepare_parse_request(str(missing_file))

    def test_prepare_parse_request_rejects_change_tracking_format(self):
        options = ParseOptions(formats=["markdown", "changeTracking"])
        with pytest.raises(ValueError, match="do not support change tracking"):
            _prepare_parse_request(
                b"<html><body><h1>Parse</h1></body></html>",
                options,
                filename="upload.html",
                content_type="text/html",
            )

    def test_prepare_parse_request_rejects_video_format(self):
        options = ParseOptions(formats=["video"])
        with pytest.raises(ValueError, match="do not support video output"):
            _prepare_parse_request(
                b"<html><body><h1>Parse</h1></body></html>",
                options,
                filename="upload.html",
                content_type="text/html",
            )

    def test_prepare_parse_request_strips_lockdown(self):
        options = ParseOptions(formats=["markdown"], lockdown=True)
        fields, _ = _prepare_parse_request(
            b"<html><body><h1>Parse</h1></body></html>",
            options,
            filename="upload.html",
            content_type="text/html",
        )

        payload = json.loads(fields["options"])
        assert "lockdown" not in payload

    def test_prepare_parse_request_strips_min_age(self):
        options = ParseOptions(formats=["markdown"], min_age=1000)
        fields, _ = _prepare_parse_request(
            b"<html><body><h1>Parse</h1></body></html>",
            options,
            filename="upload.html",
            content_type="text/html",
        )

        payload = json.loads(fields["options"])
        assert "minAge" not in payload
        assert "min_age" not in payload
