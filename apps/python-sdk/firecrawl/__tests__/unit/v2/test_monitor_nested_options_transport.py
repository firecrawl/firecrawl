import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import MonitorTarget, ScrapeOptions


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("update", [False, True])
def test_monitor_typed_scrape_options_reach_transport_as_api_keys(async_mode, update):
    bodies = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            bodies.append(body)
            monitor = {"id": "fixture", "name": "fixture", "status": "active",
                       "schedule": {"cron": "0 0 * * *"}, "targets": body["targets"],
                       "retentionDays": 7, "createdAt": "fixture", "updatedAt": "fixture"}
            response = json.dumps({"success": True, "data": monitor}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        do_PATCH = do_POST

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    target = MonitorTarget(type="scrape", urls=["https://example.com"], scrape_options=ScrapeOptions(
        formats=["raw_html"], only_main_content=False, wait_for=150, include_tags=["main"]))
    targets = [target, {"type": "search", "queries": ["fixture"], "futureField": False}]
    try:
        if async_mode:
            async def run():
                client = AsyncFirecrawlClient(api_key="fc-fixture", api_url=url, timeout=2, max_retries=0)
                try:
                    if update:
                        return await client.update_monitor("fixture", targets=targets)
                    return await client.create_monitor("fixture", {"cron": "0 0 * * *"}, targets)
                finally:
                    await client.async_http_client.close()
            result = asyncio.run(run())
        else:
            client = FirecrawlClient(api_key="fc-fixture", api_url=url, timeout=2, max_retries=0)
            result = client.update_monitor("fixture", targets=targets) if update else client.create_monitor(
                "fixture", {"cron": "0 0 * * *"}, targets)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.id == "fixture"
    assert len(bodies) == 1
    options = bodies[0]["targets"][0]["scrapeOptions"]
    assert options["onlyMainContent"] is False
    assert options["waitFor"] == 150
    assert options["includeTags"] == ["main"]
    assert options["formats"] == ["rawHtml"]
    assert "only_main_content" not in options
    assert "wait_for" not in options
    assert bodies[0]["targets"][1]["futureField"] is False
    assert target.scrape_options.only_main_content is False
