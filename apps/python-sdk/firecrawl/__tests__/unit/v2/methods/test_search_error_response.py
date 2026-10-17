import asyncio
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import AsyncMock, Mock

import pytest
import requests

from firecrawl.v2.methods.search import search
from firecrawl.v2.methods.aio.search import search as search_async
from firecrawl.v2.types import SearchRequest
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.error_handler import UnauthorizedError


@pytest.mark.parametrize("async_mode", [False, True])
def test_search_preserves_exception_without_response(async_mode):
    error = requests.ConnectionError("transport unavailable")
    client = Mock()
    client.post = AsyncMock(side_effect=error) if async_mode else Mock(side_effect=error)
    with pytest.raises(requests.ConnectionError) as caught:
        if async_mode:
            asyncio.run(search_async(client, SearchRequest(query="fixture")))
        else:
            search(client, SearchRequest(query="fixture"))
    assert caught.value is error


def test_search_preserves_real_json_decode_failure():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", "8")
            self.end_headers()
            self.wfile.write(b"not json")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        client = HttpClient(None, f"http://127.0.0.1:{server.server_port}", timeout=2, max_retries=0)
        with pytest.raises(requests.exceptions.JSONDecodeError):
            search(client, SearchRequest(query="fixture"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("async_mode", [False, True])
def test_search_still_raises_typed_api_error(async_mode):
    response = requests.Response()
    response.status_code = 401
    response._content = b'{"error":"invalid key","code":"UNAUTHORIZED"}'
    client = Mock()
    client.post = AsyncMock(return_value=response) if async_mode else Mock(return_value=response)
    with pytest.raises(UnauthorizedError) as caught:
        if async_mode:
            asyncio.run(search_async(client, SearchRequest(query="fixture")))
        else:
            search(client, SearchRequest(query="fixture"))
    assert caught.value.status_code == 401
    assert caught.value.code == "UNAUTHORIZED"
