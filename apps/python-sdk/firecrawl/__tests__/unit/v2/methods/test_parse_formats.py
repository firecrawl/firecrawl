import asyncio
from unittest.mock import Mock

import httpx2
import pytest

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.types import ParseFormat
from firecrawl.v2.utils.error_handler import FirecrawlError, InternalServerError, UnauthorizedError

API_URL = "https://api.example.test"
API_KEY = "fc-test-key"

FORMATS_BODY = {
    "success": True,
    "data": {
        "formats": [
            {
                "format": "pdf",
                "kind": "document",
                "extensions": [".pdf"],
                "mimeTypes": ["application/pdf"],
                "available": True,
            },
            {
                "format": "png",
                "kind": "image",
                "extensions": [".png"],
                "mimeTypes": ["image/png"],
                "available": False,
            },
            {
                "format": "glb",
                "kind": "model",
                "extensions": [".glb"],
                "mimeTypes": ["model/gltf-binary"],
                "available": True,
                "maxBytes": 1024,
            },
        ]
    },
}


def _assert_formats(formats):
    assert all(isinstance(f, ParseFormat) for f in formats)
    pdf, png, glb = formats
    assert pdf.format == "pdf"
    assert pdf.kind == "document"
    assert pdf.extensions == [".pdf"]
    assert pdf.mime_types == ["application/pdf"]
    assert pdf.available is True
    assert png.kind == "image"
    assert png.mime_types == ["image/png"]
    assert png.available is False
    assert glb.kind == "model"
    assert not hasattr(glb, "maxBytes")


def _sync_response(status_code, body):
    response = Mock()
    response.status_code = status_code
    response.ok = status_code < 400
    response.json.return_value = body
    return response


def test_get_parse_formats_sync(monkeypatch):
    get = Mock(return_value=_sync_response(200, FORMATS_BODY))
    monkeypatch.setattr("firecrawl.v2.utils.http_client.requests.get", get)

    formats = Firecrawl(api_key=API_KEY, api_url=API_URL).get_parse_formats()

    get.assert_called_once()
    assert get.call_args.args[0] == f"{API_URL}/v2/parse/formats"
    assert get.call_args.kwargs["headers"]["Authorization"] == f"Bearer {API_KEY}"
    _assert_formats(formats)


def test_get_parse_formats_sync_v2_surface(monkeypatch):
    monkeypatch.setattr(
        "firecrawl.v2.utils.http_client.requests.get",
        Mock(return_value=_sync_response(200, FORMATS_BODY)),
    )
    _assert_formats(Firecrawl(api_key=API_KEY, api_url=API_URL).v2.get_parse_formats())


def test_get_parse_formats_sync_unauthorized(monkeypatch):
    monkeypatch.setattr(
        "firecrawl.v2.utils.http_client.requests.get",
        Mock(return_value=_sync_response(401, {"success": False, "error": "Unauthorized"})),
    )
    with pytest.raises(UnauthorizedError):
        Firecrawl(api_key=API_KEY, api_url=API_URL).get_parse_formats()


def test_get_parse_formats_sync_unsuccessful_body(monkeypatch):
    monkeypatch.setattr(
        "firecrawl.v2.utils.http_client.requests.get",
        Mock(return_value=_sync_response(200, {"success": False, "error": "nope"})),
    )
    with pytest.raises(FirecrawlError):
        Firecrawl(api_key=API_KEY, api_url=API_URL).get_parse_formats()


def _run_async(handler, call):
    async def run():
        client = AsyncFirecrawl(api_key=API_KEY, api_url=API_URL)
        http = client._v2_client.async_http_client
        headers = http._client.headers
        await http.close()
        http._client = httpx2.AsyncClient(
            base_url=API_URL,
            headers=headers,
            transport=httpx2.MockTransport(handler),
        )
        try:
            return await call(client)
        finally:
            await http.close()

    return asyncio.run(run())


def test_get_parse_formats_async():
    requests_seen = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests_seen.append(request)
        return httpx2.Response(200, json=FORMATS_BODY)

    formats = _run_async(handler, lambda client: client.get_parse_formats())

    assert len(requests_seen) == 1
    request = requests_seen[0]
    assert request.method == "GET"
    assert str(request.url) == f"{API_URL}/v2/parse/formats"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    _assert_formats(formats)


def test_get_parse_formats_async_v2_surface():
    formats = _run_async(
        lambda request: httpx2.Response(200, json=FORMATS_BODY),
        lambda client: client.v2.get_parse_formats(),
    )
    _assert_formats(formats)


def test_get_parse_formats_async_server_error():
    with pytest.raises(InternalServerError):
        _run_async(
            lambda request: httpx2.Response(500, json={"success": False, "error": "boom"}),
            lambda client: client.get_parse_formats(),
        )


def test_get_parse_formats_async_unsuccessful_body():
    with pytest.raises(FirecrawlError):
        _run_async(
            lambda request: httpx2.Response(200, json={"success": False, "error": "nope"}),
            lambda client: client.get_parse_formats(),
        )
