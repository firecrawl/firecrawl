"""
Canonical docstrings for the research paper index (``/v2/search/research``).

Single source of truth for the prose that documents ``search_papers``,
``inspect_paper``, ``read_paper``, ``related_papers`` and ``search_github``.
The same five methods are surfaced at six layers — the implementation functions
in ``research.py`` and ``aio/research.py``, and the delegating methods on
``FirecrawlClient``, ``AsyncFirecrawlClient``, ``Firecrawl`` and
``AsyncFirecrawl``. Every layer keeps a full docstring (``help()`` on any of
them shows the complete text), but the text lives here once, so a correction to
a factual claim — corpus size and composition, the
``search(categories=["research"])`` disambiguation, wire names, Args/Returns —
is a one-place edit instead of a six-way edit that drifts.

Apply a constant with the :func:`doc` decorator::

    @doc(SEARCH_PAPERS_DOC)
    def search_papers(client, query, ...):
        ...

``*_DOC`` documents the module-level functions, which take an explicit
``client``; ``CLIENT_*_DOC`` documents the client methods, which forward
``**kwargs``. The ``AIO_*`` and ``ASYNC_CLIENT_*`` variants are the same text
with the async wording substituted, never a separate copy of the prose.
"""

from typing import Callable, TypeVar

F = TypeVar("F", bound=Callable)


def doc(text: str) -> Callable[[F], F]:
    """Attach ``text`` as the docstring of the decorated function.

    The function itself is returned unchanged — this only sets ``__doc__``.
    """

    def decorate(fn: F) -> F:
        fn.__doc__ = text
        return fn

    return decorate


# Placeholders that the sync/async variants below substitute. They are not
# prose, so a template can never accidentally ship with one unresolved.
_CLIENT_ARG = "|CLIENT_ARG|"
_AWAIT = "|AWAIT|"

_SYNC_CLIENT_ARG = "client: HTTP client."
_ASYNC_CLIENT_ARG = "client: Async HTTP client."


# ---------------------------------------------------------------------------
# Implementation functions (``research.py`` / ``aio/research.py``)
# ---------------------------------------------------------------------------

_SEARCH_PAPERS_TEMPLATE = """
Search the research paper index by abstract relevance.

Queries ~43M paper abstracts: PubMed, bioRxiv and medRxiv (about 90% of the
corpus — biomedical and life sciences) plus arXiv (physics, mathematics,
computer science). Semantic search over abstracts, not keyword matching.

This is **not** ``search(categories=["research"])``. That option only
restricts ordinary web search to ~14 academic websites and returns page
snippets; this function searches the paper index and returns paper records.

Args:
    |CLIENT_ARG|
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

_INSPECT_PAPER_TEMPLATE = """
Fetch metadata for a single paper in the research paper index.

Resolves against the same ~43M-abstract corpus as ``search_papers``
(PubMed / bioRxiv / medRxiv / arXiv).

Args:
    |CLIENT_ARG|
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

_READ_PAPER_TEMPLATE = """
Read inside a paper: return the passages of its body that best match a query.

Full-text passage retrieval over the research paper index (PubMed /
bioRxiv / medRxiv / arXiv). Use this to answer a specific question against
one paper instead of re-reading the whole document.

Args:
    |CLIENT_ARG|
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

_RELATED_PAPERS_TEMPLATE = """
Find papers related to a seed paper via the citation graph.

Walks citations/references within the research paper index (PubMed /
bioRxiv / medRxiv / arXiv) and re-ranks candidates against your stated
``intent``, so "related" means related *for your purpose*, not merely
co-cited.

Args:
    |CLIENT_ARG|
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

_SEARCH_GITHUB_TEMPLATE = """
Search the developer index: GitHub issue/PR history and repository readmes.

This is the code-and-discussion companion to ``search_papers`` and is served
by the same ``/v2/search/research`` surface. It searches indexed GitHub
history and readmes — it does **not** search the paper corpus, and it is not
the same as ``search(categories=["github"])`` (which is a ``site:github.com``
filter on ordinary web search).

Args:
    |CLIENT_ARG|
    query: Natural-language query, e.g. ``"pysam VCF parsing memory leak"``.
    k: Maximum number of results to return.

Returns:
    Raw API ``dict`` with ``success`` and ``results``. Keys are camelCase and
    are **not** normalized to snake_case — expect ``resultType``, ``repo``,
    ``url``, ``pageType``, ``number`` and a ``scoreBreakdown`` object.
"""

SEARCH_PAPERS_DOC = _SEARCH_PAPERS_TEMPLATE.replace(_CLIENT_ARG, _SYNC_CLIENT_ARG)
AIO_SEARCH_PAPERS_DOC = _SEARCH_PAPERS_TEMPLATE.replace(_CLIENT_ARG, _ASYNC_CLIENT_ARG)
INSPECT_PAPER_DOC = _INSPECT_PAPER_TEMPLATE.replace(_CLIENT_ARG, _SYNC_CLIENT_ARG)
AIO_INSPECT_PAPER_DOC = _INSPECT_PAPER_TEMPLATE.replace(_CLIENT_ARG, _ASYNC_CLIENT_ARG)
READ_PAPER_DOC = _READ_PAPER_TEMPLATE.replace(_CLIENT_ARG, _SYNC_CLIENT_ARG)
AIO_READ_PAPER_DOC = _READ_PAPER_TEMPLATE.replace(_CLIENT_ARG, _ASYNC_CLIENT_ARG)
RELATED_PAPERS_DOC = _RELATED_PAPERS_TEMPLATE.replace(_CLIENT_ARG, _SYNC_CLIENT_ARG)
AIO_RELATED_PAPERS_DOC = _RELATED_PAPERS_TEMPLATE.replace(_CLIENT_ARG, _ASYNC_CLIENT_ARG)
SEARCH_GITHUB_DOC = _SEARCH_GITHUB_TEMPLATE.replace(_CLIENT_ARG, _SYNC_CLIENT_ARG)
AIO_SEARCH_GITHUB_DOC = _SEARCH_GITHUB_TEMPLATE.replace(_CLIENT_ARG, _ASYNC_CLIENT_ARG)


# ---------------------------------------------------------------------------
# Client methods (``FirecrawlClient``, ``AsyncFirecrawlClient``, ``Firecrawl``,
# ``AsyncFirecrawl``) — same prose, wrapper-shaped Args.
# ---------------------------------------------------------------------------

_CLIENT_SEARCH_PAPERS_TEMPLATE = """
Search the research paper index by abstract relevance.

Queries ~43M paper abstracts: PubMed, bioRxiv and medRxiv (about 90% of
the corpus — biomedical and life sciences) plus arXiv (physics,
mathematics, computer science). Use this for literature search.

Not to be confused with ``search(categories=["research"])``: that is a
website/domain filter on ordinary web search (it narrows Google-style
results to ~14 academic domains and returns page snippets). This method
searches the paper index itself and returns ranked paper records.

Args:
    query: Natural-language query, e.g. ``"CRISPR base editing
        off-target effects in primary human T cells"``.
    **kwargs: ``k``, ``authors``, ``categories``, ``from_date``,
        ``to_date``.

Returns:
    Raw API ``dict`` with ``success`` and ``results``. These research
    responses are **not** normalized to snake_case like the rest of the
    SDK — keys are camelCase (``paperId``, ``primaryId``, ...).

Example:
    >>> |AWAIT|firecrawl.search_papers("GLP-1 receptor agonists cardiovascular outcomes", k=10)
"""

_CLIENT_INSPECT_PAPER_TEMPLATE = """
Fetch metadata for one paper in the research paper index.

Args:
    paper_id: Canonical ``paperId`` from ``search_papers``, or a
        namespaced id key such as ``pmid:<id>``, ``pmcid:<id>``,
        ``doi:<doi>`` or ``arxiv:<id>``.

Returns:
    Raw API ``dict`` with ``success`` and ``paper``. Keys are camelCase,
    **not** snake_case-normalized (``paperId``, ``createdDate``, ...).
"""

_CLIENT_READ_PAPER_TEMPLATE = """
Read inside a paper: return the body passages that best match a query.

Full-text passage retrieval over the research paper index (PubMed /
bioRxiv / medRxiv / arXiv).

Args:
    paper_id: Canonical ``paperId`` or namespaced id key
        (``pmid:<id>``, ``pmcid:<id>``, ``doi:<doi>``, ``arxiv:<id>``).
    query: What to look for inside the paper, e.g. ``"primary endpoint
        and hazard ratio"``.
    **kwargs: ``k`` (max passages).

Returns:
    Raw API ``dict`` with ``success``, ``paper``, ``paperId``, ``query``
    and ``passages``. Keys are camelCase, **not** snake_case-normalized.
"""

_CLIENT_RELATED_PAPERS_TEMPLATE = """
Find papers related to a seed paper via the citation graph.

Candidates are re-ranked against ``intent``, so "related" means related
for your stated purpose rather than merely co-cited.

Args:
    paper_id: Seed paper — canonical ``paperId`` or namespaced id key
        (``pmid:<id>``, ``pmcid:<id>``, ``doi:<doi>``, ``arxiv:<id>``).
    intent: What you want the related papers for, e.g. ``"replication
        attempts in larger cohorts"``.
    **kwargs: ``mode``, ``k``, ``rerank``, ``anchor``.

Returns:
    Raw API ``dict`` with ``success``, ``results``, ``poolSize``,
    ``truncated`` and optional ``note``. Keys are camelCase, **not**
    snake_case-normalized (``articleRank``, ``seedOverlap``, ...).

Note:
    The JS SDK exposes this same endpoint as
    ``research.similarPapers()``.
"""

_CLIENT_SEARCH_GITHUB_TEMPLATE = """
Search the developer index: GitHub issue/PR history and repo readmes.

The code-and-discussion companion to ``search_papers``, served by the
same ``/v2/search/research`` surface. It does not search the paper
corpus, and it is not ``search(categories=["github"])`` (which is just a
``site:github.com`` filter on ordinary web search).

Args:
    query: Natural-language query, e.g. ``"pysam VCF parsing memory leak"``.
    **kwargs: ``k``.

Returns:
    Raw API ``dict`` with ``success`` and ``results``. Keys are
    camelCase, **not** snake_case-normalized.
"""

CLIENT_SEARCH_PAPERS_DOC = _CLIENT_SEARCH_PAPERS_TEMPLATE.replace(_AWAIT, "")
ASYNC_CLIENT_SEARCH_PAPERS_DOC = _CLIENT_SEARCH_PAPERS_TEMPLATE.replace(_AWAIT, "await ")
CLIENT_INSPECT_PAPER_DOC = _CLIENT_INSPECT_PAPER_TEMPLATE.replace(_AWAIT, "")
ASYNC_CLIENT_INSPECT_PAPER_DOC = _CLIENT_INSPECT_PAPER_TEMPLATE.replace(_AWAIT, "await ")
CLIENT_READ_PAPER_DOC = _CLIENT_READ_PAPER_TEMPLATE.replace(_AWAIT, "")
ASYNC_CLIENT_READ_PAPER_DOC = _CLIENT_READ_PAPER_TEMPLATE.replace(_AWAIT, "await ")
CLIENT_RELATED_PAPERS_DOC = _CLIENT_RELATED_PAPERS_TEMPLATE.replace(_AWAIT, "")
ASYNC_CLIENT_RELATED_PAPERS_DOC = _CLIENT_RELATED_PAPERS_TEMPLATE.replace(_AWAIT, "await ")
CLIENT_SEARCH_GITHUB_DOC = _CLIENT_SEARCH_GITHUB_TEMPLATE.replace(_AWAIT, "")
ASYNC_CLIENT_SEARCH_GITHUB_DOC = _CLIENT_SEARCH_GITHUB_TEMPLATE.replace(_AWAIT, "await ")
