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
from .research_docs import (
    INSPECT_PAPER_DOC,
    READ_PAPER_DOC,
    RELATED_PAPERS_DOC,
    SEARCH_GITHUB_DOC,
    SEARCH_PAPERS_DOC,
    doc,
)


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


@doc(SEARCH_PAPERS_DOC)
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


@doc(INSPECT_PAPER_DOC)
def inspect_paper(client: HttpClient, paper_id: str) -> Dict[str, Any]:
    return _get(
        client,
        f"{BASE}/papers/{quote(paper_id, safe='')}" + _query({"origin": ORIGIN}),
    )


@doc(READ_PAPER_DOC)
def read_paper(
    client: HttpClient,
    paper_id: str,
    query: str,
    *,
    k: Optional[int] = None,
) -> Dict[str, Any]:
    return _get(
        client,
        f"{BASE}/papers/{quote(paper_id, safe='')}"
        + _query({"query": query, "k": k, "origin": ORIGIN}),
    )


@doc(RELATED_PAPERS_DOC)
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


@doc(SEARCH_GITHUB_DOC)
def search_github(
    client: HttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> Dict[str, Any]:
    return _get(
        client,
        BASE + "/github" + _query({"query": query, "k": k, "origin": ORIGIN}),
    )
