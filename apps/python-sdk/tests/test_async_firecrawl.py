import pytest
import asyncio
from typing import Dict, Any, List
from firecrawl import AsyncFirecrawlApp, SearchResponse, FirecrawlDocument

@pytest.mark.asyncio
async def test_async_search_response_type():
    """Test that async search returns proper SearchResponse object"""
    app = AsyncFirecrawlApp(api_key="test-key")
    
    # Create a test document
    doc = FirecrawlDocument[Dict[str, Any]](
        url="https://example.com",
        markdown="test",
        data={}
    )
    
    # Create a SearchResponse with the document
    test_response = SearchResponse(
        success=True,
        data=[doc],
        warning=None,
        error=None
    )
    
    # Mock the _async_post_request to return the SearchResponse
    async def mock_post(*args, **kwargs):
        return test_response.model_dump()
    
    app._async_post_request = mock_post
    result = await app.search("test query")
    
    # Check type and content
    assert isinstance(result, SearchResponse)
    assert result.success == test_response.success
    assert len(result.data) == len(test_response.data)
    assert result.warning == test_response.warning
    assert result.error == test_response.error

@pytest.mark.asyncio
async def test_async_search_error_handling():
    """Test error handling in async search"""
    app = AsyncFirecrawlApp(api_key="test-key")
    
    async def mock_error_post(*args, **kwargs):
        raise Exception("API Error")
    
    app._async_post_request = mock_error_post
    
    with pytest.raises(Exception):
        await app.search("test query")
