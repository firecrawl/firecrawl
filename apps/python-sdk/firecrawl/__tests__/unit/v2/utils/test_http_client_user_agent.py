"""Both v2 HTTP clients must present an identifiable User-Agent.

Site operators block Firecrawl by matching this header (see #1169), so it must
be stamped on every request, must not be duplicated, and must still let a
caller override it.
"""

from unittest.mock import MagicMock, patch

import pytest

from firecrawl.v2.utils.get_version import get_version
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient

API_URL = "https://api.firecrawl.dev"
EXPECTED_UA = f"FireCrawl/{get_version()}"


def _response(status_code=200, payload=None):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = payload or {"success": True}
    response.text = "{}"
    response.headers = {}
    return response


@pytest.fixture
def sync_client():
    return HttpClient(api_key="fc-test", api_url=API_URL)


def _sent_headers(mock_call):
    return mock_call.call_args.kwargs["headers"]


@pytest.mark.parametrize(
    "method_name,http_verb,payload",
    [
        ("post", "post", {"url": "https://example.com"}),
        ("get", "get", None),
        ("delete", "delete", None),
        ("patch", "patch", {"url": "https://example.com"}),
    ],
)
def test_sync_client_stamps_user_agent(sync_client, method_name, http_verb, payload):
    with patch(f"requests.{http_verb}", return_value=_response()) as verb:
        method = getattr(sync_client, method_name)
        if payload is None:
            method(f"{API_URL}/v2/x")
        else:
            method(f"{API_URL}/v2/x", payload)

    assert _sent_headers(verb)["User-Agent"] == EXPECTED_UA


def test_sync_client_keeps_auth_when_the_caller_passes_headers(sync_client):
    with patch("requests.post", return_value=_response()) as post:
        sync_client.post(
            f"{API_URL}/v2/x", {}, headers={"X-Custom": "1"}
        )

    headers = _sent_headers(post)
    assert headers["X-Custom"] == "1"
    assert headers["User-Agent"] == EXPECTED_UA
    assert headers["Authorization"] == "Bearer fc-test"


def test_sync_client_lets_the_caller_override_the_user_agent(sync_client):
    with patch("requests.get", return_value=_response()) as get:
        sync_client.get(f"{API_URL}/v2/x", headers={"User-Agent": "Custom/1.0"})

    headers = _sent_headers(get)
    assert headers["User-Agent"] == "Custom/1.0"
    assert [k for k in headers if k.lower() == "user-agent"] == ["User-Agent"]


def test_multipart_post_keeps_the_user_agent_and_drops_content_type(sync_client):
    upload = MagicMock()
    upload.name = "file.txt"
    with patch("requests.post", return_value=_response()) as post:
        sync_client.post_multipart(f"{API_URL}/v2/x", {}, files={"file": upload})

    headers = _sent_headers(post)
    assert headers["User-Agent"] == EXPECTED_UA
    assert not any(k.lower() == "content-type" for k in headers)


def test_async_client_configures_user_agent_on_the_transport():
    client = AsyncHttpClient(api_key="fc-test", api_url=API_URL)
    try:
        assert client._client.headers["User-Agent"] == EXPECTED_UA
        assert client._client.headers["Authorization"] == "Bearer fc-test"
    finally:
        client._client.aclose = MagicMock()
