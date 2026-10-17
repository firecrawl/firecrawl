import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.types import (
    Document,
    QuestionFormat,
    ScrapeOptions,
    SearchData,
    SearchResultImages,
    SearchResultNews,
    SearchResultWeb,
)


SEARCH_FIELDS = {
    "web": {
        "url": "https://example.com", "title": "Example", "description": "Product details",
        "position": 1, "category": "developer",
    },
    "news": {
        "url": "https://example.com", "title": "Example", "snippet": "Latest product news",
        "date": "2026-10-15", "imageUrl": "https://example.com/news.png", "position": 2,
        "category": "news",
    },
    "images": {
        "url": "https://example.com", "title": "Example", "imageUrl": "https://example.com/photo.png",
        "imageWidth": 640, "imageHeight": 480, "position": 3,
    },
}


def assert_search_fields(document, wire_fields):
    aliases = {"imageUrl": "image_url", "imageWidth": "image_width", "imageHeight": "image_height"}
    for key, value in wire_fields.items():
        assert getattr(document, aliases.get(key, key)) == value


@pytest.fixture(scope="module")
def search_server():
    state = {"data": {}, "requests": []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].append((self.path, request))
            body = json.dumps({"success": True, "data": state["data"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


async def public_search(api_url, async_client, **kwargs):
    client_type = AsyncFirecrawl if async_client else Firecrawl
    client = client_type(api_key="fc-test", api_url=api_url, max_retries=1)
    try:
        result = client.search("example product", **kwargs)
        return await result if async_client else result
    finally:
        if async_client:
            await client._v2_client.async_http_client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("async_client", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("source", ["web", "news", "images"])
@pytest.mark.parametrize(
    "format_option, field, value",
    [
        (QuestionFormat(question="What is the price?"), "answer", "$19"),
        ("images", "images", ["https://example.com/product.png"]),
    ],
    ids=["question", "page-images"],
)
async def test_search_preserves_scraped_content(
    search_server, async_client, source, format_option, field, value
):
    api_url, state = search_server
    # search/scrape.ts merges each scraped Document, including its metadata,
    # into the original result for all three search sources.
    state["data"] = {
        source: [{
            **SEARCH_FIELDS[source],
            "metadata": {"sourceURL": "https://example.com", "statusCode": 200},
            field: value,
        }]
    }

    result = await public_search(
        api_url, async_client, sources=[source],
        scrape_options=ScrapeOptions(formats=[format_option]),
    )

    document = getattr(result, source)[0]
    assert isinstance(document, Document)
    assert getattr(document, field) == value
    assert document.metadata.source_url == "https://example.com"
    assert_search_fields(document, SEARCH_FIELDS[source])
    for exclude_none in (False, True):
        restored = SearchData.model_validate(result.model_dump(exclude_none=exclude_none))
        restored_document = getattr(restored, source)[0]
        assert isinstance(restored_document, Document)
        assert getattr(restored_document, field) == value
        assert_search_fields(restored_document, SEARCH_FIELDS[source])
    path, request = state["requests"][-1]
    assert path == "/v2/search"
    assert request["scrapeOptions"]["formats"] == [
        {"type": "question", "question": "What is the price?"}
        if field == "answer" else "images"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("async_client", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("content", [{"answer": ""}, {"images": []}, {}])
async def test_search_preserves_empty_content_and_scrape_error_metadata(
    search_server, async_client, content
):
    api_url, state = search_server
    metadata = {"statusCode": 200} if content else {
        "statusCode": 500, "error": "Scraping failed"
    }
    state["data"] = {"web": [{
        **SEARCH_FIELDS["web"], "metadata": metadata, **content
    }]}

    result = await public_search(api_url, async_client)

    document = result.web[0]
    assert isinstance(document, Document)
    assert_search_fields(document, SEARCH_FIELDS["web"])
    for field, value in content.items():
        assert getattr(document, field) == value
    assert document.metadata.status_code == metadata["statusCode"]
    if not content:
        assert document.metadata.error == "Scraping failed"
        assert document.metadata.source_url is None
    restored = SearchData.model_validate(result.model_dump(exclude_none=True)).web[0]
    assert isinstance(restored, Document)
    assert_search_fields(restored, SEARCH_FIELDS["web"])
    assert restored.metadata.status_code == metadata["statusCode"]


@pytest.mark.asyncio
@pytest.mark.parametrize("async_client", [False, True], ids=["sync", "async"])
async def test_search_preserves_plain_result_models(
    search_server, async_client
):
    api_url, state = search_server
    plain = {"url": "https://example.com", "title": "Example"}
    state["data"] = {
        "web": [plain],
        "news": [plain],
        "images": [plain],
    }

    result = await public_search(api_url, async_client)

    for source, result_type in (
        ("web", SearchResultWeb), ("news", SearchResultNews), ("images", SearchResultImages)
    ):
        item = getattr(result, source)[0]
        assert isinstance(item, result_type)
        assert item.title == "Example"
        assert item.url == "https://example.com"
        restored = getattr(SearchData.model_validate(result.model_dump()), source)[0]
        assert isinstance(restored, result_type)


@pytest.mark.asyncio
@pytest.mark.parametrize("async_client", [False, True], ids=["sync", "async"])
async def test_search_preserves_legacy_documents_without_metadata(search_server, async_client):
    api_url, state = search_server
    state["data"] = {"web": [{**SEARCH_FIELDS["web"], "markdown": "# Legacy"}]}

    result = await public_search(api_url, async_client)

    for response in (result, SearchData.model_validate(result.model_dump(exclude_none=True))):
        assert isinstance(response.web[0], Document)
        assert response.web[0].markdown == "# Legacy"
        assert_search_fields(response.web[0], SEARCH_FIELDS["web"])
