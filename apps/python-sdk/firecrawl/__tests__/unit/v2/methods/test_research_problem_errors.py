"""Research's forwarded Problem Details remain actionable SDK errors."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.utils.error_handler import BadRequestError



CASES = [
    ({"type": "https://owned.invalid/problems/query", "title": "Invalid query", "detail": "Provide a narrower query"}, "Provide a narrower query", "https://owned.invalid/problems/query"),
    ({"type": "https://owned.invalid/problems/query", "title": "Invalid query"}, "Invalid query", "https://owned.invalid/problems/query"),
    ({"error": "Original error", "code": "ORIGINAL", "detail": "Do not replace", "type": "ignored"}, "Original error", "ORIGINAL"),
]

@pytest.fixture
def endpoint():
    state = {"body": None, "path": None}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["path"] = self.path
            self.send_response(400)
            self.send_header("Content-Type", "application/problem+json")
            self.end_headers()
            self.wfile.write(json.dumps(state["body"]).encode())
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

@pytest.mark.parametrize("body,message,code", CASES)
def test_sync_problem_error(endpoint, body, message, code):
    url, state = endpoint
    state["body"] = body
    client = FirecrawlClient(api_key="owned", api_url=url, max_retries=0, timeout=2)
    with pytest.raises(BadRequestError) as raised:
        client.search_papers("owned query")
    assert message in str(raised.value)
    assert raised.value.code == code
    assert raised.value.status_code == 400
    assert state["path"].startswith("/v2/search/research/papers?")

@pytest.mark.asyncio
@pytest.mark.parametrize("body,message,code", CASES)
async def test_async_problem_error(endpoint, body, message, code):
    url, state = endpoint
    state["body"] = body
    client = AsyncFirecrawlClient(api_key="owned", api_url=url, max_retries=0, timeout=2)
    try:
        with pytest.raises(BadRequestError) as raised:
            await client.search_papers("owned query")
        assert message in str(raised.value)
        assert raised.value.code == code
        assert raised.value.status_code == 400
        assert state["path"].startswith("/v2/search/research/papers?")
    finally:
        await client.async_http_client.close()
