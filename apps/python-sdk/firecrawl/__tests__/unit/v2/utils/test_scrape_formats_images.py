"""Image output requested with ScrapeFormats must reach the API."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.types import ScrapeFormats, ScrapeOptions
from firecrawl.v2.utils.validation import prepare_scrape_options


@pytest.mark.parametrize("formats, expected", [
    (ScrapeFormats(images=True), ["markdown", "images"]),
    (ScrapeFormats(markdown=False, images=True), ["images"]),
    (ScrapeFormats(markdown=False, images=True, formats=["links"]), ["links", "images"]),
    (ScrapeFormats(images=False), ["markdown"]),
])
def test_images_boolean_in_scrape_formats(formats, expected):
    original = formats.model_dump()
    payload = prepare_scrape_options(ScrapeOptions(formats=formats))
    assert payload["formats"] == expected
    assert formats.model_dump() == original


@pytest.fixture(scope="module")
def scrape_api():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, payload))
            data = {"metadata": {"sourceURL": payload["url"]}}
            if "images" in payload.get("formats", []):
                data["images"] = ["https://example.com/photo.png"]
            encoded = json.dumps({"success": True, "data": data}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:%s" % server.server_port, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def assert_image_request(requests, markdown):
    assert len(requests) == 1
    path, payload = requests[0]
    assert path == "/v2/scrape"
    assert payload["url"] == "https://example.com"
    assert payload["formats"] == (["markdown", "images"] if markdown else ["images"])


@pytest.mark.parametrize("markdown", [True, False])
def test_sync_scrape_requests_images(scrape_api, markdown):
    api_url, requests = scrape_api
    requests.clear()
    client = Firecrawl(api_key="fc-test", api_url=api_url, timeout=5, max_retries=1)
    document = client.scrape(
        "https://example.com", formats=ScrapeFormats(markdown=markdown, images=True)
    )
    assert_image_request(requests, markdown)
    assert document.images == ["https://example.com/photo.png"]


@pytest.mark.asyncio
@pytest.mark.parametrize("markdown", [True, False])
async def test_async_scrape_requests_images(scrape_api, markdown):
    api_url, requests = scrape_api
    requests.clear()
    client = AsyncFirecrawl(api_key="fc-test", api_url=api_url, timeout=5, max_retries=1)
    try:
        document = await client.scrape(
            "https://example.com", formats=ScrapeFormats(markdown=markdown, images=True)
        )
    finally:
        await client._v2_client.async_http_client.close()
    assert_image_request(requests, markdown)
    assert document.images == ["https://example.com/photo.png"]
