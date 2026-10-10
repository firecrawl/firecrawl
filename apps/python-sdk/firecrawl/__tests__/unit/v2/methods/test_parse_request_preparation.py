import json
import asyncio
import os
import tempfile
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


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("filename", [None, "report.html"])
def test_parse_accepts_file_descriptor_names(async_mode, filename):
    from firecrawl.v2.methods.aio.parse import _prepare_parse_request as prepare_async

    with tempfile.TemporaryFile(mode="w+b") as backing, os.fdopen(os.dup(backing.fileno()), "w+b") as file:
        file.write(b"<html>temporary upload</html>")
        file.seek(0)
        if async_mode:
            _, files = asyncio.run(prepare_async(file, filename=filename))
        else:
            _, files = _prepare_parse_request(file, filename=filename)

    name, content, mime = files["file"]
    assert name == (filename or "upload")
    assert content == b"<html>temporary upload</html>"
    assert mime == ("text/html" if filename else "application/octet-stream")


def test_parse_preserves_named_binary_file_basename(tmp_path):
    path = tmp_path / "report.html"
    path.write_bytes(b"<html>named upload</html>")
    with path.open("rb") as file:
        _, files = _prepare_parse_request(file)
    assert files["file"] == ("report.html", b"<html>named upload</html>", "text/html")
