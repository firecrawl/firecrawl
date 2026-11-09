"""Unit tests for configurable request origin attribution."""

import importlib
import sys

from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient
from firecrawl.v2.utils.get_version import get_version


def test_http_client_default_origin():
    client = HttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev")
    assert client.origin == f"python-sdk@{get_version()}"


def test_http_client_custom_origin():
    client = HttpClient(
        api_key="fc-test",
        api_url="https://api.firecrawl.dev",
        origin="arcade-mcp",
    )
    assert client.origin == "arcade-mcp"


def test_async_http_client_custom_origin():
    client = AsyncHttpClient(
        api_key="fc-test",
        api_url="https://api.firecrawl.dev",
        origin="arcade-mcp",
    )
    assert client.origin == "arcade-mcp"


def test_firecrawl_clients_construct_with_origin_and_expose_wait_crawl():
    from firecrawl import Firecrawl, AsyncFirecrawl

    sync_client = Firecrawl(api_key="fc-test", origin="arcade-mcp")
    assert sync_client._v2_client.http_client.origin == "arcade-mcp"
    assert callable(sync_client.wait_crawl)

    async_client = AsyncFirecrawl(api_key="fc-test", origin="arcade-mcp")
    assert callable(async_client.wait_crawl)


def test_sync_wait_crawl_polls_until_terminal(monkeypatch):
    from firecrawl.v2.client import FirecrawlClient
    from firecrawl.v2.methods import crawl as crawl_module
    from firecrawl.v2.types import CrawlJob

    statuses = iter(["scraping", "completed"])

    def fake_status(client, job_id, request_timeout=None):
        return CrawlJob(status=next(statuses), completed=0, total=0, credits_used=0, data=[])

    monkeypatch.setattr(crawl_module, "get_crawl_status", fake_status)
    monkeypatch.setattr(crawl_module.time, "sleep", lambda _: None)

    client = FirecrawlClient(api_key="fc-test")
    assert client.wait_crawl("job-1", poll_interval=0).status == "completed"


class _FakeResponse:
    status_code = 200
    ok = True

    def json(self):
        return {"success": True, "data": {}}


def _capture_sync(monkeypatch, method):
    import firecrawl.v2.utils.http_client as http_module

    sent = {}

    def fake_request(url, headers=None, json=None, timeout=None, **kwargs):
        sent["json"] = json
        return _FakeResponse()

    monkeypatch.setattr(http_module.requests, method, fake_request)
    return sent


def test_sync_post_and_patch_stamp_client_origin(monkeypatch):
    client = HttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev", origin="arcade-mcp")

    sent = _capture_sync(monkeypatch, "post")
    client.post("/v2/scrape", {"url": "https://example.com"})
    assert sent["json"]["origin"] == "arcade-mcp"

    sent = _capture_sync(monkeypatch, "patch")
    client.patch("/v2/monitor/x", {"name": "n"})
    assert sent["json"]["origin"] == "arcade-mcp"


def test_sync_post_keeps_explicit_request_origin(monkeypatch):
    client = HttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev", origin="arcade-mcp")
    sent = _capture_sync(monkeypatch, "post")
    client.post("/v2/scrape", {"url": "https://example.com", "origin": "per-call"})
    assert sent["json"]["origin"] == "per-call"


def test_async_post_stamps_client_origin_and_keeps_explicit_one():
    import asyncio
    import json
    import httpx

    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True})

    async def run():
        client = AsyncHttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev", origin="arcade-mcp")
        client._client = httpx.AsyncClient(
            base_url="https://api.firecrawl.dev", transport=httpx.MockTransport(handler)
        )
        await client.post("/v2/scrape", {"url": "https://example.com"})
        await client.post("/v2/scrape", {"url": "https://example.com", "origin": "per-call"})
        await client.close()

    asyncio.run(run())
    assert [body["origin"] for body in sent] == ["arcade-mcp", "per-call"]


def test_parse_multipart_options_carry_client_origin():
    import json
    from firecrawl.v2.methods.parse import _prepare_parse_request

    fields, _ = _prepare_parse_request(b"hello", filename="a.txt", origin="arcade-mcp")
    assert json.loads(fields["options"])["origin"] == "arcade-mcp"

    fields, _ = _prepare_parse_request(b"hello", filename="a.txt")
    assert json.loads(fields["options"])["origin"] == f"python-sdk@{get_version()}"


def test_research_get_query_carries_client_origin():
    from firecrawl.v2.methods import research

    class FakeClient:
        origin = "arcade-mcp"

        def get(self, path):
            self.path = path
            return _FakeResponse()

    client = FakeClient()
    research.search_papers(client, "transformers")
    assert "origin=arcade-mcp" in client.path


def _install_fake_package(tmp_path, monkeypatch, install_dir="site-packages"):
    from firecrawl.v2.utils import caller_origin

    package = tmp_path / install_dir / "wrapper_pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        "from firecrawl.v2.utils.http_client import HttpClient\n"
        "def make(**kwargs):\n"
        "    return HttpClient(api_key='fc-test', api_url='https://api.firecrawl.dev', **kwargs)\n"
    )
    monkeypatch.syspath_prepend(str(tmp_path / install_dir))
    monkeypatch.setattr(caller_origin, "_distributions", lambda: {"wrapper_pkg": ["Wrapper_Pkg.Extras"]})
    monkeypatch.delenv("FIRECRAWL_DISABLE_CALLER_ORIGIN", raising=False)
    monkeypatch.delitem(sys.modules, "wrapper_pkg", raising=False)
    return importlib.import_module("wrapper_pkg")


def test_default_origin_names_installed_wrapper_package(tmp_path, monkeypatch):
    wrapper = _install_fake_package(tmp_path, monkeypatch)
    assert wrapper.make().origin == f"python-sdk.wrapper-pkg-extras@{get_version()}"


def test_default_origin_reads_dist_packages(tmp_path, monkeypatch):
    wrapper = _install_fake_package(tmp_path, monkeypatch, install_dir="dist-packages")
    assert wrapper.make().origin == f"python-sdk.wrapper-pkg-extras@{get_version()}"


def test_explicit_origin_wins_over_wrapper_default(tmp_path, monkeypatch):
    wrapper = _install_fake_package(tmp_path, monkeypatch)
    assert wrapper.make(origin="custom").origin == "custom"


def test_wrapper_origin_can_be_disabled(tmp_path, monkeypatch):
    wrapper = _install_fake_package(tmp_path, monkeypatch)
    monkeypatch.setenv("FIRECRAWL_DISABLE_CALLER_ORIGIN", "1")
    assert wrapper.make().origin == f"python-sdk@{get_version()}"


def test_unmapped_package_keeps_plain_origin(tmp_path, monkeypatch):
    from firecrawl.v2.utils import caller_origin

    wrapper = _install_fake_package(tmp_path, monkeypatch)
    monkeypatch.setattr(caller_origin, "_distributions", lambda: {})
    assert wrapper.make().origin == f"python-sdk@{get_version()}"


def test_detection_failure_keeps_plain_origin(tmp_path, monkeypatch):
    from firecrawl.v2.utils import caller_origin

    wrapper = _install_fake_package(tmp_path, monkeypatch)

    def boom():
        raise RuntimeError("metadata unavailable")

    monkeypatch.setattr(caller_origin, "_distributions", boom)
    assert wrapper.make().origin == f"python-sdk@{get_version()}"


def test_playground_named_package_keeps_plain_origin(tmp_path, monkeypatch):
    from firecrawl.v2.utils import caller_origin

    wrapper = _install_fake_package(tmp_path, monkeypatch)
    monkeypatch.setattr(caller_origin, "_distributions", lambda: {"wrapper_pkg": ["my-playground-kit"]})
    assert wrapper.make().origin == f"python-sdk@{get_version()}"
