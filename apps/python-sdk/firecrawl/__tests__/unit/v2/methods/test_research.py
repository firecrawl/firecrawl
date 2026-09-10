"""
Unit tests for the v2 research paper index methods.

Mirrors the JS SDK suite in
``apps/js-sdk/firecrawl/src/__tests__/unit/v2/research.test.ts``: the HTTP
client is mocked and the tests pin the method names, the request paths and the
query-string construction. No network access.

These endpoints are the research paper index (``/v2/search/research``) — not the
``search(categories=["research"])`` website filter.
"""

from urllib.parse import parse_qs, urlparse

import pytest

from firecrawl.v2.methods import research
from firecrawl.v2.utils.error_handler import (
    BadRequestError,
    FirecrawlError,
)


class FakeResponse:
    """Minimal stand-in for ``requests.Response``."""

    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeHttpClient:
    """Records every path requested through ``get``."""

    def __init__(self, response=None):
        self.calls = []
        self._response = response or FakeResponse()

    def get(self, path):
        self.calls.append(path)
        return self._response

    @property
    def last_path(self):
        return self.calls[-1]


def split(path):
    """Split a recorded path into (path, {param: [values]})."""
    parsed = urlparse(path)
    return parsed.path, parse_qs(parsed.query, keep_blank_values=True)


class TestSearchPapers:
    """search_papers -> GET /v2/search/research/papers"""

    def test_builds_query_string_with_exploded_arrays(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.search_papers(
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
        # list values are exploded into repeated params, not comma-joined
        assert qs["authors"] == ["Ho", "Abbeel"]
        assert qs["categories"] == ["cs.LG", "stat.ML"]
        # from_date/to_date are sent as the wire names `from`/`to`
        assert qs["from"] == ["2020-01-01"]
        assert qs["to"] == ["2024-12-31"]

    def test_biomedical_query_is_passed_through_percent_encoded(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.search_papers(
            client, "CRISPR base editing off-target effects in T cells"
        )
        assert "CRISPR%20base%20editing" in client.last_path
        _, qs = split(client.last_path)
        assert qs["query"] == ["CRISPR base editing off-target effects in T cells"]

    def test_omits_absent_options(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.search_papers(client, "q")
        path, qs = split(client.last_path)
        assert path == "/v2/search/research/papers"
        assert sorted(qs.keys()) == ["origin", "query"]
        assert qs["origin"][0].startswith("python-sdk@")

    def test_returns_the_response_body_verbatim(self):
        payload = {
            "success": True,
            "results": [
                {
                    "paperId": "1",
                    "primaryId": "pmid:12345678",
                    "title": "t",
                    "abstract": "a",
                    "score": 0.1,
                }
            ],
        }
        client = FakeHttpClient(FakeResponse(200, payload))
        assert research.search_papers(client, "q") == payload

    def test_response_keys_are_not_snake_case_normalized(self):
        """Research responses are returned raw; keys stay camelCase."""
        payload = {"success": True, "results": [{"paperId": "1", "primaryId": "doi:10.1/x"}]}
        client = FakeHttpClient(FakeResponse(200, payload))
        result = research.search_papers(client, "q")
        assert "paperId" in result["results"][0]
        assert "paper_id" not in result["results"][0]


class TestInspectPaper:
    """inspect_paper -> GET /v2/search/research/papers/{id}"""

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
            ("123456789", "/v2/search/research/papers/123456789"),
        ],
    )
    def test_encodes_namespaced_ids_in_the_path(self, paper_id, expected_path):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "paper": {}}))
        research.inspect_paper(client, paper_id)
        path, _ = split(client.last_path)
        assert path == expected_path

    def test_sends_origin_like_the_other_research_methods(self):
        """Detail mode sends ``origin`` too — same attribution as the other four."""
        client = FakeHttpClient(FakeResponse(200, {"success": True, "paper": {}}))
        research.inspect_paper(client, "pmid:12345678")
        _, qs = split(client.last_path)
        assert sorted(qs.keys()) == ["origin"]
        assert qs["origin"][0].startswith("python-sdk@")


class TestReadPaper:
    """read_paper -> GET /v2/search/research/papers/{id}?query=..."""

    def test_adds_query_and_k(self):
        client = FakeHttpClient(
            FakeResponse(200, {"success": True, "paper": {}, "passages": []})
        )
        research.read_paper(
            client,
            "pmid:12345678",
            "what was the primary endpoint?",
            k=4,
        )
        path, qs = split(client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678"
        assert qs["query"] == ["what was the primary endpoint?"]
        assert qs["k"] == ["4"]
        assert qs["origin"][0].startswith("python-sdk@")

    def test_omits_k_when_absent(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "paper": {}}))
        research.read_paper(client, "123", "noise schedule")
        _, qs = split(client.last_path)
        assert sorted(qs.keys()) == ["origin", "query"]


class TestRelatedPapers:
    """related_papers -> GET /v2/search/research/papers/{id}/similar

    Same endpoint the JS SDK exposes as ``research.similarPapers()``.
    """

    def test_builds_path_and_query_with_repeated_anchors_and_rerank(self):
        client = FakeHttpClient(
            FakeResponse(200, {"success": True, "results": [], "poolSize": 0, "truncated": False})
        )
        research.related_papers(
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
        # booleans are lower-cased, not Python-cased
        assert qs["rerank"] == ["false"]
        assert qs["anchor"] == ["arxiv:2006.11239", "1503.03585"]

    def test_rerank_true_is_lowercased(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.related_papers(client, "1", "intent", rerank=True)
        _, qs = split(client.last_path)
        assert qs["rerank"] == ["true"]

    def test_omits_rerank_when_none(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.related_papers(client, "1", "intent")
        _, qs = split(client.last_path)
        assert "rerank" not in qs
        assert qs["intent"] == ["intent"]


class TestSearchGithub:
    """search_github -> GET /v2/search/research/github"""

    def test_builds_query_string(self):
        client = FakeHttpClient(FakeResponse(200, {"success": True, "results": []}))
        research.search_github(client, "milvus hybrid search", k=10)
        path, qs = split(client.last_path)
        assert path == "/v2/search/research/github"
        assert qs["query"] == ["milvus hybrid search"]
        assert qs["k"] == ["10"]
        assert qs["origin"][0].startswith("python-sdk@")


class TestErrorMapping:
    """Non-200 responses raise the shared v2 error types."""

    def test_400_raises_bad_request(self):
        client = FakeHttpClient(FakeResponse(400, {"error": "query is required"}))
        with pytest.raises(BadRequestError) as exc:
            research.search_papers(client, "q")
        assert "query is required" in str(exc.value)
        assert exc.value.status_code == 400

    def test_404_raises_firecrawl_error(self):
        client = FakeHttpClient(FakeResponse(404, {"error": "Not Found"}))
        with pytest.raises(FirecrawlError) as exc:
            research.inspect_paper(client, "pmid:0")
        assert exc.value.status_code == 404

    def test_error_action_is_labelled_research(self):
        client = FakeHttpClient(FakeResponse(500, {"error": "boom"}))
        with pytest.raises(FirecrawlError) as exc:
            research.search_github(client, "q")
        assert "research" in str(exc.value)


class TestClientWiring:
    """Pin the public method names on the sync client."""

    def _client(self, response=None):
        from firecrawl.v2.client import FirecrawlClient

        client = FirecrawlClient(api_key="fc-test")
        client.http_client = FakeHttpClient(response or FakeResponse(200, {"success": True}))
        return client

    def test_client_exposes_research_methods(self):
        from firecrawl.v2.client import FirecrawlClient

        for name in (
            "search_papers",
            "inspect_paper",
            "read_paper",
            "related_papers",
            "search_github",
        ):
            assert callable(getattr(FirecrawlClient, name)), name

    def test_search_papers_routes_to_the_paper_index(self):
        client = self._client(FakeResponse(200, {"success": True, "results": []}))
        client.search_papers("tau aggregation inhibitors", k=5)
        path, qs = split(client.http_client.last_path)
        assert path == "/v2/search/research/papers"
        assert qs["k"] == ["5"]

    def test_read_paper_routes_to_the_paper_id_path(self):
        client = self._client(FakeResponse(200, {"success": True, "paper": {}}))
        client.read_paper("pmid:12345678", "primary endpoint", k=2)
        path, qs = split(client.http_client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678"
        assert qs["query"] == ["primary endpoint"]

    def test_related_papers_routes_to_similar(self):
        client = self._client(FakeResponse(200, {"success": True, "results": []}))
        client.related_papers("pmid:12345678", intent="replication attempts")
        path, _ = split(client.http_client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678/similar"

    def test_research_methods_are_documented(self):
        """The docstrings are the disambiguation surface agents actually read."""
        from firecrawl.v2.client import FirecrawlClient

        doc = FirecrawlClient.search_papers.__doc__ or ""
        assert "PubMed" in doc
        assert 'categories=["research"]' in doc


RESEARCH_METHODS = (
    "search_papers",
    "inspect_paper",
    "read_paper",
    "related_papers",
    "search_github",
)


class TestUnifiedClientWiring:
    """The top-level ``Firecrawl`` client is what the README instantiates.

    ``Firecrawl`` does not inherit from the v2 client (unlike the JS SDK, where
    ``Firecrawl extends FirecrawlClient``) — it delegates method by method. Any
    method missing from that list is simply absent from the documented surface,
    so pin all five here.
    """

    def _client(self, response=None):
        from firecrawl import Firecrawl

        client = Firecrawl(api_key="fc-test")
        client._v2_client.http_client = FakeHttpClient(
            response or FakeResponse(200, {"success": True})
        )
        return client

    def test_unified_client_exposes_research_methods(self):
        from firecrawl import Firecrawl

        for name in RESEARCH_METHODS:
            assert callable(getattr(Firecrawl, name, None)), name

    def test_search_papers_delegates_to_the_paper_index(self):
        client = self._client(FakeResponse(200, {"success": True, "results": []}))
        client.search_papers("tau aggregation inhibitors", k=5)
        path, qs = split(client._v2_client.http_client.last_path)
        assert path == "/v2/search/research/papers"
        assert qs["query"] == ["tau aggregation inhibitors"]
        assert qs["k"] == ["5"]

    def test_inspect_paper_delegates(self):
        client = self._client(FakeResponse(200, {"success": True, "paper": {}}))
        client.inspect_paper("pmid:12345678")
        path, _ = split(client._v2_client.http_client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678"

    def test_read_paper_delegates(self):
        client = self._client(FakeResponse(200, {"success": True, "passages": []}))
        client.read_paper("pmid:12345678", "primary endpoint", k=4)
        path, qs = split(client._v2_client.http_client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678"
        assert qs["query"] == ["primary endpoint"]
        assert qs["k"] == ["4"]

    def test_related_papers_delegates(self):
        client = self._client(FakeResponse(200, {"success": True, "results": []}))
        client.related_papers("pmid:12345678", intent="replication attempts", k=20)
        path, qs = split(client._v2_client.http_client.last_path)
        assert path == "/v2/search/research/papers/pmid%3A12345678/similar"
        assert qs["intent"] == ["replication attempts"]
        assert qs["k"] == ["20"]

    def test_search_github_delegates(self):
        client = self._client(FakeResponse(200, {"success": True, "results": []}))
        client.search_github("pysam VCF parsing memory leak", k=3)
        path, qs = split(client._v2_client.http_client.last_path)
        assert path == "/v2/search/research/github"
        assert qs["query"] == ["pysam VCF parsing memory leak"]

    def test_returns_the_v2_response_verbatim(self):
        payload = {"success": True, "results": [{"paperId": "1", "primaryId": "pmid:1"}]}
        client = self._client(FakeResponse(200, payload))
        assert client.search_papers("q") == payload

    def test_delegated_docstrings_carry_the_disambiguation(self):
        from firecrawl import Firecrawl

        doc = Firecrawl.search_papers.__doc__ or ""
        assert "PubMed" in doc
        assert 'categories=["research"]' in doc
        for name in RESEARCH_METHODS:
            assert (getattr(Firecrawl, name).__doc__ or "").strip(), name


class TestDocstringSingleSourceOfTruth:
    """The five docstrings live once, in ``v2/methods/research_docs.py``.

    Six layers surface the same five methods. Each keeps a full docstring, but
    the prose is applied from the canonical constants, so a correction to a
    factual claim is a one-place edit. These tests fail if a layer forks its
    own copy again.
    """

    def _layers(self):
        from firecrawl import AsyncFirecrawl, Firecrawl
        from firecrawl.v2.client import FirecrawlClient
        from firecrawl.v2.client_async import AsyncFirecrawlClient
        from firecrawl.v2.methods import research as sync_research
        from firecrawl.v2.methods import research_docs as docs
        from firecrawl.v2.methods.aio import research as aio_research

        return docs, {
            "impl": (sync_research, ""),
            "impl_aio": (aio_research, "AIO_"),
            "v2_client": (FirecrawlClient, "CLIENT_"),
            "v2_client_async": (AsyncFirecrawlClient, "ASYNC_CLIENT_"),
            "unified": (Firecrawl, "CLIENT_"),
            "unified_async": (AsyncFirecrawl, "ASYNC_CLIENT_"),
        }

    def test_every_layer_uses_the_canonical_docstring(self):
        docs, layers = self._layers()
        for name in RESEARCH_METHODS:
            for label, (obj, prefix) in layers.items():
                canonical = getattr(docs, f"{prefix}{name.upper()}_DOC")
                assert getattr(obj, name).__doc__ == canonical, f"{label}.{name}"

    def test_no_unresolved_placeholders_ship_to_users(self):
        """A template placeholder leaking into ``help()`` would be user-visible."""
        docs, layers = self._layers()
        for name in RESEARCH_METHODS:
            for obj, _ in layers.values():
                assert "|" not in (getattr(obj, name).__doc__ or "")
