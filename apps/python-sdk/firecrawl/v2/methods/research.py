"""
Research functionality for Firecrawl v2 API.
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
    return _get(client, f"{BASE}/papers/{quote(paper_id, safe='')}")


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
