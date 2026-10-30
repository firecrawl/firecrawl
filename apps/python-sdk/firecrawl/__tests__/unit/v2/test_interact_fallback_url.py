"""Exercise fallback URLs through the public clients and real HTTP transports."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl, FirecrawlError


JOB_ID = "job-123"
FALLBACK_URL = "https://example.com/recover?view=details#section"
EXECUTIONS = [
    pytest.param({"code": "print(await page.title())"}, id="code"),
    pytest.param({"prompt": "Read the page title"}, id="prompt"),
]
URL_OPTIONS = [
    pytest.param({"url": FALLBACK_URL}, id="url"),
    pytest.param({}, id="omitted"),
    pytest.param({"url": None}, id="none"),
]


@pytest.fixture
def local_api():
    state = SimpleNamespace(
        requests=[],
        status=200,
        response={"success": True, "stdout": "ok", "exitCode": 0},
    )

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state.requests.append((self.path, body))
            response = json.dumps(state.response).encode()
            self.send_response(state.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01))
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def assert_request(api, execution, url_options):
    expected = {
        "language": "python",
        "timeout": 45,
        "origin": "_unit-test",
        **execution,
    }
    if url_options.get("url") is not None:
        expected["url"] = url_options["url"]
    assert api.requests == [(f"/v2/scrape/{JOB_ID}/interact", expected)]


@pytest.mark.parametrize("method_name", ["interact", "scrape_execute"])
@pytest.mark.parametrize("execution", EXECUTIONS)
@pytest.mark.parametrize("url_options", URL_OPTIONS)
def test_sync_interact_fallback_url(local_api, method_name, execution, url_options):
    sdk = Firecrawl(api_key="fc-unit-test", api_url=local_api.url, timeout=5)
    response = getattr(sdk, method_name)(
        JOB_ID,
        **execution,
        **url_options,
        language="python",
        timeout=45,
        origin="_unit-test",
    )

    assert_request(local_api, execution, url_options)
    assert response.success is True
    assert response.stdout == "ok"
    assert response.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("method_name", ["interact", "scrape_execute"])
@pytest.mark.parametrize("execution", EXECUTIONS)
@pytest.mark.parametrize("url_options", URL_OPTIONS)
async def test_async_interact_fallback_url(
    local_api, method_name, execution, url_options
):
    sdk = AsyncFirecrawl(api_key="fc-unit-test", api_url=local_api.url, timeout=5)
    try:
        response = await getattr(sdk, method_name)(
            JOB_ID,
            **execution,
            **url_options,
            language="python",
            timeout=45,
            origin="_unit-test",
        )

        assert_request(local_api, execution, url_options)
        assert response.success is True
        assert response.stdout == "ok"
        assert response.exit_code == 0
    finally:
        await sdk._v2_client.async_http_client.close()


@pytest.mark.parametrize("method_name", ["interact", "scrape_execute"])
def test_sync_interact_preserves_api_error_with_url(local_api, method_name):
    local_api.status = 409
    local_api.response = {"success": False, "error": "Replay context is unavailable"}
    sdk = Firecrawl(api_key="fc-unit-test", api_url=local_api.url, timeout=5)

    with pytest.raises(FirecrawlError, match="Replay context is unavailable") as exc:
        getattr(sdk, method_name)(JOB_ID, prompt="Read the title", url=FALLBACK_URL)

    assert exc.value.status_code == 409
    assert len(local_api.requests) == 1
    assert local_api.requests[0][1]["url"] == FALLBACK_URL


@pytest.mark.asyncio
@pytest.mark.parametrize("method_name", ["interact", "scrape_execute"])
async def test_async_interact_preserves_api_error_with_url(local_api, method_name):
    local_api.status = 409
    local_api.response = {"success": False, "error": "Replay context is unavailable"}
    sdk = AsyncFirecrawl(api_key="fc-unit-test", api_url=local_api.url, timeout=5)
    try:
        with pytest.raises(FirecrawlError, match="Replay context is unavailable") as exc:
            await getattr(sdk, method_name)(
                JOB_ID, prompt="Read the title", url=FALLBACK_URL
            )

        assert exc.value.status_code == 409
        assert len(local_api.requests) == 1
        assert local_api.requests[0][1]["url"] == FALLBACK_URL
    finally:
        await sdk._v2_client.async_http_client.close()
