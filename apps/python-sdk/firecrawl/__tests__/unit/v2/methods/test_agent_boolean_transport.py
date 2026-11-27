import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from firecrawl.v2.methods.agent import start_agent
from firecrawl.v2.methods.aio.agent import start_agent as start_agent_async
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("constraint", [False, True, None])
def test_agent_url_constraint_survives_http_serialization(async_mode, constraint):
    bodies = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            bodies.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            response = b'{"success":true,"id":"fixture-agent","status":"processing"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        if async_mode:
            async def run():
                client = AsyncHttpClient(None, url, timeout=2, max_retries=0)
                try:
                    return await start_agent_async(client, ["https://example.com"], prompt="fixture",
                        strict_constrain_to_urls=constraint)
                finally:
                    await client.close()
            result = asyncio.run(run())
        else:
            client = HttpClient(None, url, timeout=2, max_retries=0)
            result = start_agent(client, ["https://example.com"], prompt="fixture",
                strict_constrain_to_urls=constraint)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.id == "fixture-agent"
    assert len(bodies) == 1
    if constraint is None:
        assert "strictConstrainToURLs" not in bodies[0]
    else:
        assert bodies[0]["strictConstrainToURLs"] is constraint
