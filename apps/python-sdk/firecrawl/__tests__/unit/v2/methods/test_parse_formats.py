import asyncio
from unittest.mock import Mock

import httpx
import pytest

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.types import ParseFormat
from firecrawl.v2.utils.error_handler import InternalServerError, UnauthorizedError

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


def _async_client(handler):
    client = AsyncFirecrawl(api_key=API_KEY, api_url=API_URL)
    http = client._v2_client.async_http_client
    http._client = httpx.AsyncClient(
        base_url=API_URL,
        headers=http._client.headers,
        transport=httpx.MockTransport(handler),
    )
    return client


def test_get_parse_formats_async():
    requests_seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(request)
        return httpx.Response(200, json=FORMATS_BODY)

    client = _async_client(handler)
    formats = asyncio.run(client.get_parse_formats())

    assert len(requests_seen) == 1
    request = requests_seen[0]
    assert request.method == "GET"
    assert str(request.url) == f"{API_URL}/v2/parse/formats"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    _assert_formats(formats)


def test_get_parse_formats_async_v2_surface():
    client = _async_client(lambda request: httpx.Response(200, json=FORMATS_BODY))
    _assert_formats(asyncio.run(client.v2.get_parse_formats()))


def test_get_parse_formats_async_server_error():
    client = _async_client(
        lambda request: httpx.Response(500, json={"success": False, "error": "boom"})
    )
    with pytest.raises(InternalServerError):
        asyncio.run(client.get_parse_formats())
