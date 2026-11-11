"""Legacy JSON extraction settings must reach the v2 API unchanged."""

import copy
import inspect
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from pydantic import BaseModel

from firecrawl import AsyncFirecrawl, Firecrawl, ScrapeOptions, V1JsonConfig
from firecrawl.v2.types import ScrapeFormats
from firecrawl.v2.utils import v1_compat


SCHEMA = {
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "required": ["name"],
    "additionalProperties": False,
}
JSON_OPTIONS = {"schema": SCHEMA, "prompt": "Extract the product name"}


@pytest.fixture(scope="module")
def local_api():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, payload))
            if self.path == "/v2/scrape":
                body = {
                    "success": True,
                    "data": {
                        "json": {"name": "Example"},
                        "metadata": {"sourceURL": "https://example.com", "statusCode": 200},
                    },
                }
            elif self.path in ("/v2/crawl", "/v2/batch/scrape"):
                body = {"success": True, "id": "job-1", "url": "https://example.com/job-1"}
            else:
                self.send_error(404)
                return
            encoded = json.dumps(body).encode("utf-8")
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


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type,operation", [
    (Firecrawl, "scrape"),
    (AsyncFirecrawl, "scrape"),
    (Firecrawl, "crawl"),
    (AsyncFirecrawl, "crawl"),
    (Firecrawl, "batch"),
])
@pytest.mark.parametrize("option_name", ["jsonOptions", "json_options"])
@pytest.mark.parametrize("json_options", [
    JSON_OPTIONS,
    {"schema": SCHEMA},
    {"prompt": "Extract the product name"},
    {"schema": {**SCHEMA, "properties": {"name": {"type": "string", "default": None}}}},
])
async def test_legacy_json_options_reach_api(
    local_api, monkeypatch, client_type, option_name, operation, json_options
):
    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = client_type(api_key="fc-test", api_url=api_url)
    options = {"formats": ["markdown", "json"], option_name: copy.deepcopy(json_options)}
    params = {"scrapeOptions": options} if operation == "crawl" else options
    original = copy.deepcopy(params)
    method_name = {
        "scrape": "scrape_url",
        "crawl": "async_crawl_url",
        "batch": "async_batch_scrape_urls",
    }[operation]
    argument = ["https://example.com"] if operation == "batch" else "https://example.com"

    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        result = getattr(client, method_name)(argument, params=params)
        if inspect.isawaitable(result):
            result = await result

    assert result["success"] is True
    assert len(requests) == 1
    path, payload = requests[0]
    assert path == {"scrape": "/v2/scrape", "crawl": "/v2/crawl", "batch": "/v2/batch/scrape"}[operation]
    scrape_options = payload["scrapeOptions"] if operation == "crawl" else payload
    assert scrape_options["formats"] == [
        "markdown",
        {"type": "json", **json_options},
    ]
    assert "jsonOptions" not in scrape_options
    assert "json_options" not in scrape_options
    assert params == original


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type,operation", [
    (Firecrawl, "scrape"),
    (AsyncFirecrawl, "scrape"),
    (Firecrawl, "crawl"),
    (AsyncFirecrawl, "crawl"),
    (Firecrawl, "batch"),
])
async def test_legacy_typed_json_options_reach_api(local_api, monkeypatch, client_type, operation):
    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = client_type(api_key="fc-test", api_url=api_url)
    config = V1JsonConfig(**copy.deepcopy(JSON_OPTIONS))

    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        if operation == "crawl":
            options = ScrapeOptions(formats=["json"], jsonOptions=config)
            result = client.async_crawl_url("https://example.com", params={"scrapeOptions": options})
        elif operation == "batch":
            result = client.async_batch_scrape_urls(
                ["https://example.com"], params={"formats": ["json"], "jsonOptions": config}
            )
        else:
            result = client.scrape_url(
                "https://example.com", params={"formats": ["json"], "jsonOptions": config}
            )
        if inspect.isawaitable(result):
            result = await result

    assert result["success"] is True
    assert len(requests) == 1
    payload = requests[0][1]
    options = payload["scrapeOptions"] if operation == "crawl" else payload
    assert options["formats"] == [
        {"type": "json", "schema": SCHEMA, "prompt": "Extract the product name"},
    ]
    assert config.model_dump(by_alias=True, exclude_none=True) == JSON_OPTIONS


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [Firecrawl, AsyncFirecrawl])
@pytest.mark.parametrize("typed_config", [False, True])
async def test_legacy_schema_class_reaches_api(local_api, monkeypatch, client_type, typed_config):
    class Product(BaseModel):
        name: str

    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = client_type(api_key="fc-test", api_url=api_url)
    config = V1JsonConfig(schema=Product) if typed_config else {"schema": Product}

    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        result = client.scrape_url(
            "https://example.com", params={"formats": ["json"], "jsonOptions": config}
        )
        if inspect.isawaitable(result):
            result = await result

    assert result["json"] == {"name": "Example"}
    assert len(requests) == 1
    assert requests[0][1]["formats"] == [{"type": "json", "schema": Product.model_json_schema()}]


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [Firecrawl, AsyncFirecrawl])
async def test_v2_json_format_remains_unchanged(local_api, client_type):
    api_url, requests = local_api
    requests.clear()
    client = client_type(api_key="fc-test", api_url=api_url)
    formats = [{"type": "json", "schema": copy.deepcopy(SCHEMA), "prompt": "Extract the product name"}]
    result = client.scrape("https://example.com", formats=formats)
    if inspect.isawaitable(result):
        result = await result

    assert result.json == {"name": "Example"}
    assert requests[0][1]["formats"] == [
        {"type": "json", "schema": SCHEMA, "prompt": "Extract the product name"},
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [Firecrawl, AsyncFirecrawl])
@pytest.mark.parametrize("operation", ["scrape", "crawl"])
async def test_legacy_tuple_formats_reach_api(local_api, monkeypatch, client_type, operation):
    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = client_type(api_key="fc-test", api_url=api_url)
    options = {"formats": ("markdown", "json"), "jsonOptions": copy.deepcopy(JSON_OPTIONS)}
    original = copy.deepcopy(options)
    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        result = (
            client.scrape_url("https://example.com", params=options) if operation == "scrape"
            else client.async_crawl_url("https://example.com", params={"scrapeOptions": options})
        )
        if inspect.isawaitable(result):
            await result
    assert len(requests) == 1
    payload = requests[0][1]
    payload = payload["scrapeOptions"] if operation == "crawl" else payload
    assert payload["formats"] == ["markdown", {"type": "json", **JSON_OPTIONS}]
    assert options == original


@pytest.mark.parametrize("formats", [None, "json", ScrapeFormats(json=True), {"json": True}])
def test_legacy_json_options_reject_unsupported_formats(local_api, monkeypatch, formats):
    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = Firecrawl(api_key="fc-test", api_url=api_url)
    params = {"jsonOptions": copy.deepcopy(JSON_OPTIONS)}
    if formats is not None:
        params["formats"] = formats
    original = copy.deepcopy(params)
    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        with pytest.raises(ValueError, match="json_options requires a list or tuple of formats"):
            client.scrape_url("https://example.com", params=params)
    assert not requests
    assert params == original


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [Firecrawl, AsyncFirecrawl])
@pytest.mark.parametrize("value", [None, False, True])
async def test_legacy_typed_config_aliases_reach_api(local_api, monkeypatch, client_type, value):
    api_url, requests = local_api
    requests.clear()
    monkeypatch.setattr(v1_compat, "_warned", False)
    client = client_type(api_key="fc-test", api_url=api_url)
    config = V1JsonConfig(**copy.deepcopy(JSON_OPTIONS), checkPromptInjection=value)
    original = config.model_dump(by_alias=True)
    with pytest.warns(DeprecationWarning, match="v1-style calls"):
        result = client.scrape_url(
            "https://example.com", params={"formats": ["json"], "jsonOptions": config}
        )
        if inspect.isawaitable(result):
            await result
    expected = {"type": "json", **JSON_OPTIONS}
    if value is not None:
        expected["checkPromptInjection"] = value
    assert len(requests) == 1
    assert requests[0][1]["formats"] == [expected]
    assert config.model_dump(by_alias=True) == original
