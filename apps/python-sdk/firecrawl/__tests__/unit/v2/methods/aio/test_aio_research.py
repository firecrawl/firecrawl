"""
Unit tests for the async v2 research paper index methods.

Async mirror of ``firecrawl/__tests__/unit/v2/methods/test_research.py``: the
async HTTP client is mocked and the tests pin the method names, the request
paths and the query-string construction. No network access.
"""

from urllib.parse import parse_qs, urlparse

import pytest

from firecrawl.v2.methods.aio import research as aio_research
from firecrawl.v2.utils.error_handler import BadRequestError, FirecrawlError


class FakeResponse:
    """Minimal stand-in for an httpx/requests-style response."""

    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeAsyncHttpClient:
    """Records every path requested through ``await get``."""

    def __init__(self, response=None):
        self.calls = []
        self._response = response or FakeResponse()

    async def get(self, path):
        self.calls.append(path)
        return self._response

    @property
    def last_path(self):
        return self.calls[-1]


def split(path):
    """Split a recorded path into (path, {param: [values]})."""
    parsed = urlparse(path)
    return parsed.path, parse_qs(parsed.query, keep_blank_values=True)


@pytest.mark.asyncio
async def test_search_papers_builds_query_string_with_exploded_arrays():
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "results": []}))
    await aio_research.search_papers(
        client,
        "diffusion models",
        k=10,
        authors=["Ho", "Abbeel"],
        categories=["cs.LG", "stat.ML"],
        from_date="2020-01-01",
        to_date="2024-12-31",
    )
    path, qs = split(client.last_path)
    assert path == "/v2/search/research/papers"
    assert qs["query"] == ["diffusion models"]
    assert qs["k"] == ["10"]
    assert qs["authors"] == ["Ho", "Abbeel"]
    assert qs["categories"] == ["cs.LG", "stat.ML"]
    assert qs["from"] == ["2020-01-01"]
    assert qs["to"] == ["2024-12-31"]


@pytest.mark.asyncio
async def test_search_papers_omits_absent_options():
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "results": []}))
    await aio_research.search_papers(client, "q")
    path, qs = split(client.last_path)
    assert path == "/v2/search/research/papers"
    assert sorted(qs.keys()) == ["origin", "query"]
    assert qs["origin"][0].startswith("python-sdk@")


@pytest.mark.asyncio
async def test_search_papers_returns_body_verbatim_in_camel_case():
    payload = {
        "success": True,
        "results": [{"paperId": "1", "primaryId": "pmid:12345678", "score": 0.5}],
    }
    client = FakeAsyncHttpClient(FakeResponse(200, payload))
    result = await aio_research.search_papers(client, "q")
    assert result == payload
    assert "paperId" in result["results"][0]
    assert "paper_id" not in result["results"][0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paper_id, expected_path",
    [
        ("arxiv:2105.05233", "/v2/search/research/papers/arxiv%3A2105.05233"),
        ("pmid:12345678", "/v2/search/research/papers/pmid%3A12345678"),
        ("pmcid:PMC1234567", "/v2/search/research/papers/pmcid%3APMC1234567"),
        (
            "doi:10.1038/s41586-020-2649-2",
            "/v2/search/research/papers/doi%3A10.1038%2Fs41586-020-2649-2",
        ),
    ],
)
async def test_inspect_paper_encodes_namespaced_ids(paper_id, expected_path):
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "paper": {}}))
    await aio_research.inspect_paper(client, paper_id)
    path, qs = split(client.last_path)
    assert path == expected_path
    # detail mode carries origin, like the other four research methods
    assert sorted(qs.keys()) == ["origin"]
    assert qs["origin"][0].startswith("python-sdk@")


@pytest.mark.asyncio
async def test_read_paper_adds_query_and_k():
    client = FakeAsyncHttpClient(
        FakeResponse(200, {"success": True, "paper": {}, "passages": []})
    )
    await aio_research.read_paper(client, "pmid:12345678", "primary endpoint", k=4)
    path, qs = split(client.last_path)
    assert path == "/v2/search/research/papers/pmid%3A12345678"
    assert qs["query"] == ["primary endpoint"]
    assert qs["k"] == ["4"]


@pytest.mark.asyncio
async def test_related_papers_builds_path_and_query():
    client = FakeAsyncHttpClient(
        FakeResponse(200, {"success": True, "results": [], "poolSize": 0, "truncated": False})
    )
    await aio_research.related_papers(
        client,
        "2105.05233",
        "diffusion image synthesis",
        mode="citers",
        k=20,
        rerank=False,
        anchor=["arxiv:2006.11239", "1503.03585"],
    )
    path, qs = split(client.last_path)
    assert path == "/v2/search/research/papers/2105.05233/similar"
    assert qs["intent"] == ["diffusion image synthesis"]
    assert qs["mode"] == ["citers"]
    assert qs["k"] == ["20"]
    assert qs["rerank"] == ["false"]
    assert qs["anchor"] == ["arxiv:2006.11239", "1503.03585"]


@pytest.mark.asyncio
async def test_related_papers_omits_rerank_when_none():
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "results": []}))
    await aio_research.related_papers(client, "1", "intent")
    _, qs = split(client.last_path)
    assert "rerank" not in qs


@pytest.mark.asyncio
async def test_search_github_builds_query_string():
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "results": []}))
    await aio_research.search_github(client, "milvus hybrid search", k=10)
    path, qs = split(client.last_path)
    assert path == "/v2/search/research/github"
    assert qs["query"] == ["milvus hybrid search"]
    assert qs["k"] == ["10"]


@pytest.mark.asyncio
async def test_error_mapping():
    client = FakeAsyncHttpClient(FakeResponse(400, {"error": "query is required"}))
    with pytest.raises(BadRequestError) as exc:
        await aio_research.search_papers(client, "q")
    assert "query is required" in str(exc.value)
    assert exc.value.status_code == 400

    client = FakeAsyncHttpClient(FakeResponse(404, {"error": "Not Found"}))
    with pytest.raises(FirecrawlError) as exc:
        await aio_research.inspect_paper(client, "pmid:0")
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_async_client_exposes_research_methods():
    from firecrawl.v2.client_async import AsyncFirecrawlClient

    for name in (
        "search_papers",
        "inspect_paper",
        "read_paper",
        "related_papers",
        "search_github",
    ):
        assert callable(getattr(AsyncFirecrawlClient, name)), name

    client = AsyncFirecrawlClient(api_key="fc-test")
    client.async_http_client = FakeAsyncHttpClient(
        FakeResponse(200, {"success": True, "results": []})
    )
    await client.search_papers("tau aggregation inhibitors", k=5)
    path, qs = split(client.async_http_client.last_path)
    assert path == "/v2/search/research/papers"
    assert qs["k"] == ["5"]


@pytest.mark.asyncio
async def test_async_research_methods_are_documented():
    """The docstrings are the disambiguation surface agents actually read."""
    from firecrawl.v2.client_async import AsyncFirecrawlClient

    doc = AsyncFirecrawlClient.search_papers.__doc__ or ""
    assert "PubMed" in doc
    assert 'categories=["research"]' in doc


RESEARCH_METHODS = (
    "search_papers",
    "inspect_paper",
    "read_paper",
    "related_papers",
    "search_github",
)


def _unified_client(response=None):
    """Top-level ``AsyncFirecrawl`` with its v2 HTTP layer mocked."""
    from firecrawl import AsyncFirecrawl

    client = AsyncFirecrawl(api_key="fc-test")
    client._v2_client.async_http_client = FakeAsyncHttpClient(
        response or FakeResponse(200, {"success": True})
    )
    return client


def test_unified_async_client_exposes_research_methods():
    """``AsyncFirecrawl`` delegates method by method; pin all five."""
    from firecrawl import AsyncFirecrawl

    for name in RESEARCH_METHODS:
        assert callable(getattr(AsyncFirecrawl, name, None)), name
        assert (getattr(AsyncFirecrawl, name).__doc__ or "").strip(), name

    doc = AsyncFirecrawl.search_papers.__doc__ or ""
    assert "PubMed" in doc
    assert 'categories=["research"]' in doc


@pytest.mark.asyncio
async def test_unified_async_client_delegates_all_research_methods():
    client = _unified_client(FakeResponse(200, {"success": True, "results": []}))
    http = client._v2_client.async_http_client

    await client.search_papers("tau aggregation inhibitors", k=5)
    path, qs = split(http.last_path)
    assert path == "/v2/search/research/papers"
    assert qs["k"] == ["5"]

    await client.inspect_paper("pmid:12345678")
    path, _ = split(http.last_path)
    assert path == "/v2/search/research/papers/pmid%3A12345678"

    await client.read_paper("pmid:12345678", "primary endpoint", k=4)
    path, qs = split(http.last_path)
    assert path == "/v2/search/research/papers/pmid%3A12345678"
    assert qs["query"] == ["primary endpoint"]

    await client.related_papers("pmid:12345678", intent="replication attempts")
    path, qs = split(http.last_path)
    assert path == "/v2/search/research/papers/pmid%3A12345678/similar"
    assert qs["intent"] == ["replication attempts"]

    await client.search_github("pysam VCF parsing memory leak")
    path, qs = split(http.last_path)
    assert path == "/v2/search/research/github"
    assert qs["query"] == ["pysam VCF parsing memory leak"]


@pytest.mark.asyncio
async def test_unified_async_client_returns_response_verbatim():
    payload = {"success": True, "results": [{"paperId": "1", "primaryId": "pmid:1"}]}
    client = _unified_client(FakeResponse(200, payload))
    assert await client.search_papers("q") == payload
