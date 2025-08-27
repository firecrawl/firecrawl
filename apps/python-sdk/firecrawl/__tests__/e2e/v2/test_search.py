from firecrawl import Firecrawl
import os
from dotenv import load_dotenv
from firecrawl.types import SearchData, Document, ScrapeOptions, SearchResultWeb, SearchResultNews, SearchResultImages

load_dotenv()

firecrawl = Firecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))

def _collect_texts(entries):
    texts = []
    for r in entries or []:
        title = getattr(r, 'title', None) if hasattr(r, 'title') else None
        desc = getattr(r, 'description', None) if hasattr(r, 'description') else None
        if title:
            texts.append(str(title).lower())
        if desc:
            texts.append(str(desc).lower())
    return texts

def _is_document(entry) -> bool:
    try:
        from firecrawl.v2.types import Document
        return isinstance(entry, Document) or \
               hasattr(entry, 'markdown') or \
               hasattr(entry, 'html') or \
               hasattr(entry, 'raw_html') or \
               hasattr(entry, 'json') or \
               hasattr(entry, 'screenshot') or \
               hasattr(entry, 'change_tracking') or \
               hasattr(entry, 'summary')
    except Exception:
        return hasattr(entry, 'markdown') or \
               hasattr(entry, 'html') or \
               hasattr(entry, 'raw_html') or \
               hasattr(entry, 'json') or \
               hasattr(entry, 'screenshot') or \
               hasattr(entry, 'change_tracking') or \
               hasattr(entry, 'summary')

def test_search_minimal_request():
    results = firecrawl.search(
        query="What is the capital of France?"
    )
    
    assert isinstance(results, SearchData)
    assert hasattr(results, 'web')
    assert results.web is not None
    assert len(results.web) > 0
    assert hasattr(results, 'news')
    assert results.news is None
    assert hasattr(results, 'images')
    assert results.images is None
    
    for result in results.web:
        assert isinstance(result, SearchResultWeb)
        assert hasattr(result, 'url')
        assert hasattr(result, 'title')
        assert hasattr(result, 'description')
        assert result.url.startswith('http')
        assert result.title is not None
        assert result.description is not None

    all_text = ' '.join(_collect_texts(results.web))
    
    assert 'paris' in all_text
    
    assert results.news is None
    assert results.images is None


def test_search_with_sources():
    """Test search with specific sources."""
    results = firecrawl.search(
        query="firecrawl",
        sources=["web", "news", "images"],
        limit=3
    )
    
    assert isinstance(results, SearchData)
    
    assert results.web is not None
    assert len(results.web) <= 3
    assert isinstance(results.web[0], SearchResultWeb)
    
    if results.news is not None:
        assert len(results.news) <= 3
        assert isinstance(results.news[0], SearchResultNews)
    
    if results.images is not None:
        assert len(results.images) <= 3
        assert isinstance(results.images[0], SearchResultImages)
    
    web_titles = [result.title.lower() for result in results.web]
    web_descriptions = [result.description.lower() for result in results.web]
    all_web_text = ' '.join(web_titles + web_descriptions)
    
    assert 'firecrawl' in all_web_text

def test_search_result_structure():
    """Test that SearchResult objects have the correct structure."""
    results = firecrawl.search(
        query="test query",
        limit=1
    )
    
    if results.web and len(results.web) > 0:
        result = results.web[0]
        
        assert hasattr(result, 'url')
        assert hasattr(result, 'title')
        assert hasattr(result, 'description')
        
        assert isinstance(result.url, str)
        assert isinstance(result.title, str) or result.title is None
        assert isinstance(result.description, str) or result.description is None
        
        # Test URL format
        assert result.url.startswith('http')

def test_search_all_parameters():
    """Test search with all available parameters (comprehensive e2e test)."""
    from firecrawl.types import ScrapeOptions, JsonFormat, Location, WaitAction
    
    # Define a schema for JSON extraction
    schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "description": {"type": "string"},
            "url": {"type": "string"}
        },
        "required": ["title", "description"]
    }
    
    results = firecrawl.search(
        query="artificial intelligence",
        sources=[
            {"type": "web"},
            {"type": "news"}
        ],
        limit=3,
        tbs="qdr:m",  # Last month
        location="US",
        ignore_invalid_urls=True,
        timeout=60000,
        scrape_options=ScrapeOptions(
            formats=[
                "markdown",
                "html",
                {
                    "type": "json",
                    "prompt": "Extract the title and description from the page",
                    "schema": schema
                },
                {"type": "summary"}
            ],
            headers={"User-Agent": "Firecrawl-Test/1.0"},
            include_tags=["h1", "h2", "p"],
            exclude_tags=["nav", "footer"],
            only_main_content=True,
            wait_for=2000,
            mobile=False,
            skip_tls_verification=False,
            remove_base64_images=True,
            block_ads=True,
            proxy="basic",
            max_age=3600000,  # 1 hour cache
            store_in_cache=True,
            location=Location(
                country="US",
                languages=["en"]
            ),
            actions=[
                WaitAction(milliseconds=1000)
            ]
            # Note: raw_html and screenshot_full_page are not supported by v2 API yet
        )
    )
    
    # Test structure
    assert isinstance(results, SearchData)
    assert hasattr(results, 'web')
    assert hasattr(results, 'news')
    assert hasattr(results, 'images')
    
    # Test that web results exist
    assert results.web is not None
    assert len(results.web) <= 3  # Should respect limit
    
    # Test that results contain expected content for non-document entries only
    non_doc_entries = [r for r in (results.web or []) if not _is_document(r)]
    if non_doc_entries:
        all_web_text = ' '.join(_collect_texts(non_doc_entries))
        ai_terms = ['artificial', 'intelligence', 'ai', 'machine', 'learning']
        assert any(term in all_web_text for term in ai_terms)
    
    # Test that each result has proper structure
    for result in results.web:
        assert isinstance(result, (SearchResultWeb, Document))
        if isinstance(result, Document):
            # Document path: ensure content present
            assert (result.markdown is not None) or (result.html is not None)
        else:
            # LinkResult path
            assert hasattr(result, 'url')
            assert isinstance(result.url, str) and result.url.startswith('http')
    
    # Test that news results exist (if API supports it)
    if results.news is not None:
        assert len(results.news) <= 3
        for result in results.news:
            assert isinstance(result, (SearchResultNews, Document))
            if isinstance(result, Document):
                assert (result.markdown is not None) or (result.html is not None)
            else:
                assert hasattr(result, 'url')
                assert isinstance(result.url, str) and result.url.startswith('http')
    
    # Test that unspecified sources are None
    assert results.images is None


def test_search_formats_flexibility():
    """Test that both list and ScrapeFormats work for formats."""
    from firecrawl.types import ScrapeFormats
    
    # Test with list format
    results1 = firecrawl.search(
        query="python programming",
        limit=1,
        scrape_options=ScrapeOptions(
            formats=["markdown"]
        )
    )
    
    # Test with ScrapeFormats object
    results2 = firecrawl.search(
        query="python programming", 
        limit=1,
        scrape_options=ScrapeOptions(
            formats=ScrapeFormats(markdown=True)
        )
    )
    
    # Both should work without errors
    assert isinstance(results1, SearchData)
    assert isinstance(results2, SearchData)
    assert results1.web is not None
    assert results2.web is not None

def test_search_with_json_format_object():
    """Search with scrape_options including a JSON format object (prompt + schema)."""
    json_schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"}
        },
        "required": ["title"],
    }
    results = firecrawl.search(
        query="site:docs.firecrawl.dev",
        limit=1,
        scrape_options=ScrapeOptions(
            formats=[{"type": "json", "prompt": "Extract page title", "schema": json_schema}]
        ),
    )
    assert isinstance(results, SearchData)
    assert results.web is not None and len(results.web) >= 0