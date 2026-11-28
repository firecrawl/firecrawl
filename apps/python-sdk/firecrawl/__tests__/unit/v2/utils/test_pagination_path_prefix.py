import asyncio
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl


@pytest.mark.parametrize(
    ("client_type", "configured_path", "mount", "cursor_mount"),
    [
        pytest.param(
            AsyncFirecrawl, "/gateway/firecrawl", "/gateway/firecrawl", "",
            id="async-gateway",
        ),
        pytest.param(
            AsyncFirecrawl, "/gateway/firecrawl", "/gateway/firecrawl",
            "/gateway/firecrawl", id="async-prefixed-gateway",
        ),
        pytest.param(AsyncFirecrawl, "/v2", "/v2", "", id="async-v2-mount"),
        pytest.param(AsyncFirecrawl, "/v2", "/v2", "/v2", id="async-prefixed-v2-mount"),
        pytest.param(Firecrawl, "/v2", "", "", id="sync-root-endpoints"),
    ],
)
def test_crawl_pagination_keeps_servers_mount(
    client_type, configured_path, mount, cursor_mount
):
    endpoint = "/v2/crawl/id"
    first_path = mount + endpoint
    next_path = first_path + "?skip=1"
    requested_paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requested_paths.append(self.path)
            if self.path not in (first_path, next_path):
                self.send_error(404)
                return

            first = self.path == first_path
            response = {
                "success": True,
                "status": "completed",
                "completed": 2,
                "total": 2,
                "data": [{"markdown": "first" if first else "second"}],
            }
            if first:
                response["next"] = origin + cursor_mount + endpoint + "?skip=1"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

    async def get_async_status(client):
        try:
            return await client.get_crawl_status("id")
        finally:
            await client._v2_client.async_http_client.close()

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        origin = f"http://127.0.0.1:{server.server_port}"
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            client = client_type(
                api_key="fc-test",
                api_url=origin + configured_path + "/",
                timeout=2,
                max_retries=1,
            )
            if client_type is AsyncFirecrawl:
                job = asyncio.run(get_async_status(client))
            else:
                job = client.get_crawl_status("id")
        finally:
            server.shutdown()
            thread.join()

    assert requested_paths == [first_path, next_path]
    assert [doc.markdown for doc in job.data] == ["first", "second"]
