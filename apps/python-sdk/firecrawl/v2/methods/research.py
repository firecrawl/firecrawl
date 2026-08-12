"""
Research functionality for Firecrawl v2 API.

These functions query Firecrawl's **research paper index** (~43M paper
abstracts) served at ``/v2/search/research``. The corpus is roughly 90%
biomedical and life sciences — PubMed, bioRxiv and medRxiv — with arXiv
covering physics, mathematics and computer science.

.. warning::
   This is **not** the same thing as ``search(categories=["research"])``.
   That option is a website/domain filter applied to ordinary web search: it
   restricts Google-style results to about 14 academic domains
   (arxiv.org, pubmed.ncbi.nlm.nih.gov, nature.com, sciencedirect.com, ...)
   and returns web page snippets. The functions in this module query the
   paper index itself and return ranked paper records with full abstracts,
   passage-level reads and citation-graph neighbours.

   Use ``search_papers()`` for literature search; use
   ``search(categories=["research"])`` when you want ordinary web results
   narrowed to academic sites.

.. note::
   **Response keys are camelCase.** Unlike the rest of the Python SDK, these
   functions return the raw JSON body from the API as a ``dict``: it is not
   parsed into typed models and it is **not** normalized to snake_case. Expect
   ``paperId``, ``primaryId``, ``createdDate``, ``updateDate``,
   ``articleRank``, ``seedOverlap``, ``poolSize`` and so on.
"""

from typing import Any, Dict, List, Optional
from urllib.parse import quote

from ..utils import HttpClient, handle_response_error
from ..utils.get_version import get_version


BASE = "/v2/search/research"
ORIGIN = f"python-sdk@{get_version()}"


def _query(params: Dict[str, Any]) -> str:
    pairs: List[str] = []
    for key, value in params.items():
        if value is None:
            continue
        values = value if isinstance(value, list) else [value]
        for item in values:
            if item is not None:
                pairs.append(f"{quote(str(key), safe='')}={quote(str(item), safe='')}")
    return ("?" + "&".join(pairs)) if pairs else ""


def _get(client: HttpClient, path: str) -> Dict[str, Any]:
    response = client.get(path)
    if response.status_code != 200:
        handle_response_error(response, "research")
    return response.json()


def search_papers(
    client: HttpClient,
    query: str,
    *,
    k: Optional[int] = None,
    authors: Optional[List[str]] = None,
    categories: Optional[List[str]] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Search the research paper index by abstract relevance.

    Queries ~43M paper abstracts: PubMed, bioRxiv and medRxiv (about 90% of the
    corpus — biomedical and life sciences) plus arXiv (physics, mathematics,
    computer science). Semantic search over abstracts, not keyword matching.

    This is **not** ``search(categories=["research"])``. That option only
    restricts ordinary web search to ~14 academic websites and returns page
    snippets; this function searches the paper index and returns paper records.

    Args:
        client: HTTP client.
        query: Natural-language query, e.g. ``"CRISPR base editing off-target
            effects in primary human T cells"``.
        k: Maximum number of papers to return.
        authors: Filter by author name(s). Repeated per value.
        categories: Filter by arXiv-style subject categories (e.g. ``["q-bio.GN"]``).
            Note this is the *paper* category filter, unrelated to the
            ``categories`` argument of ``search()``.
        from_date: Inclusive lower bound on publication date (``YYYY-MM-DD``).
        to_date: Inclusive upper bound on publication date (``YYYY-MM-DD``).

    Returns:
        Raw API ``dict`` with ``success`` and ``results``. Keys are camelCase
        and are **not** normalized to snake_case: each result carries
        ``paperId``, ``primaryId`` (e.g. ``pmid:<id>``, ``doi:<id>``,
        ``arxiv:<id>``), ``ids``, ``title``, ``abstract`` and ``score``.

    Example:
        >>> res = search_papers(client, "tau aggregation inhibitors in Alzheimer's", k=10)
        >>> res["results"][0]["paperId"]

    See Also:
        ``inspect_paper``, ``read_paper``, ``related_papers``.
    """
    return _get(
        client,
        BASE
        + "/papers"
        + _query(
            {
                "query": query,
                "k": k,
                "authors": authors,
                "categories": categories,
                "from": from_date,
                "to": to_date,
                "origin": ORIGIN,
            }
        ),
    )


def inspect_paper(client: HttpClient, paper_id: str) -> Dict[str, Any]:
    """
    Fetch metadata for a single paper in the research paper index.

    Resolves against the same ~43M-abstract corpus as ``search_papers``
    (PubMed / bioRxiv / medRxiv / arXiv).

    Args:
        client: HTTP client.
        paper_id: A canonical ``paperId`` returned by ``search_papers``, or a
            namespaced id key such as ``pmid:<id>``, ``pmcid:<id>``,
            ``doi:<doi>`` or ``arxiv:<id>``. Bare arXiv ids and arXiv URLs are
            also accepted.

    Returns:
        Raw API ``dict`` with ``success`` and ``paper``. Keys are camelCase and
        are **not** normalized to snake_case — expect ``paperId``, ``ids``,
        ``title``, ``abstract``, ``authors``, ``categories``, ``createdDate``,
        ``updateDate``.

    See Also:
        ``read_paper`` to search inside the body of a paper.
    """
    return _get(
        client,
        f"{BASE}/papers/{quote(paper_id, safe='')}" + _query({"origin": ORIGIN}),
    )


def read_paper(
    client: HttpClient,
    paper_id: str,
    query: str,
    *,
    k: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Read inside a paper: return the passages of its body that best match a query.

    Full-text passage retrieval over the research paper index (PubMed /
    bioRxiv / medRxiv / arXiv). Use this to answer a specific question against
    one paper instead of re-reading the whole document.

    Args:
        client: HTTP client.
        paper_id: Canonical ``paperId`` or a namespaced id key
            (``pmid:<id>``, ``pmcid:<id>``, ``doi:<doi>``, ``arxiv:<id>``).
        query: What to look for inside the paper, e.g. ``"primary endpoint and
            hazard ratio"``.
        k: Maximum number of passages to return.

    Returns:
        Raw API ``dict`` with ``success``, ``paper``, ``paperId``, ``query`` and
        ``passages`` (each ``{"text": ..., "score": ...}``). Keys are camelCase
        and are **not** normalized to snake_case.
    """
    return _get(
        client,
        f"{BASE}/papers/{quote(paper_id, safe='')}"
        + _query({"query": query, "k": k, "origin": ORIGIN}),
    )


def related_papers(
    client: HttpClient,
    paper_id: str,
    intent: str,
    *,
    mode: Optional[str] = None,
    k: Optional[int] = None,
    rerank: Optional[bool] = None,
    anchor: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Find papers related to a seed paper via the citation graph.

    Walks citations/references within the research paper index (PubMed /
    bioRxiv / medRxiv / arXiv) and re-ranks candidates against your stated
    ``intent``, so "related" means related *for your purpose*, not merely
    co-cited.

    Args:
        client: HTTP client.
        paper_id: Seed paper — canonical ``paperId`` or a namespaced id key
            (``pmid:<id>``, ``pmcid:<id>``, ``doi:<doi>``, ``arxiv:<id>``).
        intent: Required. What you want the related papers *for*, e.g.
            ``"replication attempts in larger cohorts"``. Used to re-rank.
        mode: Traversal mode over the citation graph, e.g. ``"citers"``.
        k: Maximum number of papers to return.
        rerank: Whether to apply the intent reranker. Serialized as
            ``"true"``/``"false"``.
        anchor: Additional seed papers to anchor the neighbourhood on.

    Returns:
        Raw API ``dict`` with ``success``, ``results``, ``poolSize``,
        ``truncated`` and optional ``note``. Keys are camelCase and are **not**
        normalized to snake_case; each result carries a ``signals`` object with
        ``structural``, ``semantic``, ``articleRank`` and ``seedOverlap``.

    Note:
        This is the Python name for the endpoint the JS SDK exposes as
        ``research.similarPapers()``. Same endpoint
        (``/v2/search/research/papers/{id}/similar``), different method name.
    """
    return _get(
        client,
        f"{BASE}/papers/{quote(paper_id, safe='')}/similar"
        + _query(
            {
                "intent": intent,
                "mode": mode,
                "k": k,
                "rerank": None if rerank is None else str(rerank).lower(),
                "anchor": anchor,
                "origin": ORIGIN,
            }
        ),
    )


def search_github(
    client: HttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Search the developer index: GitHub issue/PR history and repository readmes.

    This is the code-and-discussion companion to ``search_papers`` and is served
    by the same ``/v2/search/research`` surface. It searches indexed GitHub
    history and readmes — it does **not** search the paper corpus, and it is not
    the same as ``search(categories=["github"])`` (which is a ``site:github.com``
    filter on ordinary web search).

    Args:
        client: HTTP client.
        query: Natural-language query, e.g. ``"pysam VCF parsing memory leak"``.
        k: Maximum number of results to return.

    Returns:
        Raw API ``dict`` with ``success`` and ``results``. Keys are camelCase and
        are **not** normalized to snake_case — expect ``resultType``, ``repo``,
        ``url``, ``pageType``, ``number`` and a ``scoreBreakdown`` object.
    """
    return _get(
        client,
        BASE + "/github" + _query({"query": query, "k": k, "origin": ORIGIN}),
    )
