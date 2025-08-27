import os
import json
import pytest
import requests
from dotenv import load_dotenv

load_dotenv()

def _idmux(identity_request: dict) -> dict:
    idmux_url = os.getenv("IDMUX_URL")
    if not idmux_url:
        raise EnvironmentError("IDMUX_URL is not set. E2E tests must use idmux for credentials.")
    run_number = int(os.getenv("GITHUB_RUN_NUMBER") or 0)
    payload = {
        "refName": os.getenv("GITHUB_REF_NAME") or "local",
        "runNumber": run_number,
        "concurrency": identity_request.get("concurrency", 100),
        **identity_request,
    }
    resp = requests.post(idmux_url + "/", json=payload)
    resp.raise_for_status()
    return resp.json()

@pytest.fixture(scope="session")
def api_url():
    # Prefer TEST_URL, then FIRECRAWL_API_URL (for parity with JS), then legacy API_URL
    return (
        os.getenv("TEST_URL")
        or os.getenv("FIRECRAWL_API_URL")
        or os.getenv("API_URL")
        or "https://api.firecrawl.dev"
    )

# Resolve identity and export environment at import time so tests that read env at module import succeed
_IDENTITY = None
_API_URL = (
    os.getenv("TEST_URL")
    or os.getenv("FIRECRAWL_API_URL")
    or os.getenv("API_URL")
    or "https://api.firecrawl.dev"
)

_IDMUX_URL = os.getenv("IDMUX_URL")
if _IDMUX_URL:
    run_name = os.getenv("PYTEST_RUN_NAME") or "py-e2e"
    # If IDMUX_URL is set, idmux MUST succeed; do not silently fall back
    _IDENTITY = _idmux({"name": run_name})
    os.environ["API_KEY"] = _IDENTITY.get("apiKey", "")
    os.environ["API_URL"] = _API_URL

@pytest.fixture(scope="session")
def api_identity():
    return _IDENTITY or {"apiKey": os.getenv("API_KEY") or "", "teamId": os.getenv("TEST_TEAM_ID") or os.getenv("TEAM_ID") or ""}

@pytest.fixture(autouse=True)
def _inject_client(request, api_identity, api_url):
    # For class-based tests that rely on self.client, inject a client if missing
    inst = getattr(request, "instance", None)
    if inst is not None and not hasattr(inst, "client"):
        try:
            from firecrawl import Firecrawl
            inst.client = Firecrawl(api_key=api_identity.get("apiKey", ""), api_url=api_url)
        except Exception:
            pass
    # For function-based modules that expect a module-level `firecrawl` symbol
    mod = getattr(request, "module", None)
    if mod is not None and not hasattr(mod, "firecrawl"):
        try:
            from firecrawl import Firecrawl
            setattr(mod, "firecrawl", Firecrawl(api_key=api_identity.get("apiKey", ""), api_url=api_url))
        except Exception:
            pass

