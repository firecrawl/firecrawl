"""
Unit tests for Firecrawl v2 pagination functionality.
"""

import pytest
import time
from unittest.mock import Mock, patch, AsyncMock
from typing import Dict, Any, List

from firecrawl.v2.types import (
    PaginationConfig, 
    CrawlJob, 
    BatchScrapeJob, 
    Document, 
    DocumentMetadata
)
from firecrawl.v2.methods.crawl import get_crawl_status, get_crawl_status_page, _fetch_all_pages
from firecrawl.v2.methods.batch import get_batch_scrape_status, get_batch_scrape_status_page, _fetch_all_batch_pages
from firecrawl.v2.methods.aio.crawl import (
    get_crawl_status as get_crawl_status_async,
    get_crawl_status_page as get_crawl_status_page_async,
    _fetch_all_pages_async,
)
from firecrawl.v2.methods.aio.batch import (
    get_batch_scrape_status as get_batch_scrape_status_async,
    get_batch_scrape_status_page as get_batch_scrape_status_page_async,
    _fetch_all_batch_pages_async,
)


class TestPaginationConfig:
    """Test PaginationConfig model."""
    
    def test_default_values(self):
        """Test default values for PaginationConfig."""
        config = PaginationConfig()
        assert config.auto_paginate is True
        assert config.max_pages is None
        assert config.max_results is None
        assert config.max_wait_time is None
    
    def test_custom_values(self):
        """Test custom values for PaginationConfig."""
        config = PaginationConfig(
            auto_paginate=False,
            max_pages=5,
            max_results=100,
            max_wait_time=30
        )
        assert config.auto_paginate is False
        assert config.max_pages == 5
        assert config.max_results == 100
        assert config.max_wait_time == 30


class TestCrawlPagination:
    """Test crawl pagination functionality."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = Mock()
        self.job_id = "test-crawl-123"
        
        # Sample document data
        self.sample_doc = {
            "url": "https://example.com",
            "markdown": "# Test Content",
            "metadata": {
                "title": "Test Page",
                "statusCode": 200
            }
        }
    
    def test_get_crawl_status_no_pagination(self):
        """Test get_crawl_status with auto_paginate=False."""
        # Mock response with next URL
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 10,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2",
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.return_value = mock_response
        
        # Test with auto_paginate=False
        pagination_config = PaginationConfig(auto_paginate=False)
        result = get_crawl_status(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2"
        assert len(result.data) == 1
        assert isinstance(result.data[0], Document)

    def test_get_crawl_status_propagates_request_timeout(self):
        """Ensure request_timeout is forwarded to the HTTP client."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        timeout_seconds = 5.5
        import firecrawl.v2.methods.crawl as crawl_module

        assert crawl_module.__file__.endswith("firecrawl/v2/methods/crawl.py")
        assert crawl_module.get_crawl_status.__kwdefaults__ is not None
        assert "request_timeout" in crawl_module.get_crawl_status.__kwdefaults__
        result = get_crawl_status(
            self.mock_client,
            self.job_id,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_called_with(
            f"/v2/crawl/{self.job_id}", timeout=timeout_seconds
        )

    def test_get_crawl_status_page(self):
        """Test get_crawl_status_page returns a single page."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=3",
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response
        next_url = "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2"

        result = get_crawl_status_page(self.mock_client, next_url)

        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=3"
        assert len(result.data) == 1
        self.mock_client.get.assert_called_with(next_url, timeout=None)

    def test_get_crawl_status_page_propagates_request_timeout(self):
        """Ensure request_timeout is forwarded to crawl status page requests."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        next_url = "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2"
        timeout_seconds = 4.2
        result = get_crawl_status_page(
            self.mock_client,
            next_url,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_called_with(next_url, timeout=timeout_seconds)
    
    def test_get_crawl_status_with_pagination(self):
        """Test get_crawl_status with auto_paginate=True."""
        # Mock first page response
        mock_response1 = Mock()
        mock_response1.ok = True
        mock_response1.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2",
            "data": [self.sample_doc]
        }
        
        # Mock second page response
        mock_response2 = Mock()
        mock_response2.ok = True
        mock_response2.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 20,
            "total": 20,
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Test with auto_paginate=True
        pagination_config = PaginationConfig(auto_paginate=True)
        result = get_crawl_status(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next is None  # Should be None when auto_paginate=True
        assert len(result.data) == 2
        assert self.mock_client.get.call_count == 2
    
    def test_get_crawl_status_max_pages_limit(self):
        """Test get_crawl_status with max_pages limit."""
        # Mock responses for multiple pages
        mock_responses = []
        for i in range(5):  # 5 pages available
            mock_response = Mock()
            mock_response.ok = True
            mock_response.json.return_value = {
                "success": True,
                "status": "completed",
                "completed": (i + 1) * 10,
                "total": 50,
                "creditsUsed": (i + 1) * 5,
                "expiresAt": "2024-01-01T00:00:00Z",
                "next": f"https://api.firecrawl.dev/v2/crawl/test-crawl-123?page={i+2}" if i < 4 else None,
                "data": [self.sample_doc]
            }
            mock_responses.append(mock_response)
        
        self.mock_client.get.side_effect = mock_responses
        
        # Test with max_pages=3
        pagination_config = PaginationConfig(auto_paginate=True, max_pages=3)
        result = get_crawl_status(self.mock_client, self.job_id, pagination_config)
        
        assert len(result.data) == 4  # 1 initial + 3 from pages
        assert self.mock_client.get.call_count == 4  # 1 initial + 3 pagination calls
    
    def test_get_crawl_status_max_results_limit(self):
        """Test get_crawl_status with max_results limit."""
        # Mock responses with multiple documents per page
        mock_response1 = Mock()
        mock_response1.ok = True
        mock_response1.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2",
            "data": [self.sample_doc, self.sample_doc, self.sample_doc]  # 3 docs
        }
        
        mock_response2 = Mock()
        mock_response2.ok = True
        mock_response2.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 20,
            "total": 20,
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=3",
            "data": [self.sample_doc, self.sample_doc]  # 2 more docs
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Test with max_results=4
        pagination_config = PaginationConfig(auto_paginate=True, max_results=4)
        result = get_crawl_status(self.mock_client, self.job_id, pagination_config)
        
        assert len(result.data) == 4  # Should stop at 4 results
        assert self.mock_client.get.call_count == 2  # Should fetch 2 pages
    
    def test_get_crawl_status_max_wait_time_limit(self):
        """Test get_crawl_status with max_wait_time limit."""
        # Mock slow response
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2",
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.return_value = mock_response
        
        # Test with max_wait_time=1 second
        pagination_config = PaginationConfig(auto_paginate=True, max_wait_time=1)
        
        with patch('firecrawl.v2.methods.crawl.time.monotonic', side_effect=[0, 2]):  # Simulate 2 seconds elapsed
            result = get_crawl_status(self.mock_client, self.job_id, pagination_config)
        
        assert len(result.data) == 1  # Should stop due to timeout
        assert self.mock_client.get.call_count == 1
    
    def test_fetch_all_pages_error_handling(self):
        """Test _fetch_all_pages with API errors."""
        # Mock first page success, second page error
        mock_response1 = Mock()
        mock_response1.ok = True
        mock_response1.json.return_value = {
            "success": True,
            "data": [self.sample_doc],
            "next": "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2"
        }
        
        mock_response2 = Mock()
        mock_response2.ok = False
        mock_response2.status_code = 500
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Should continue with what we have
        result = _fetch_all_pages(self.mock_client, "https://api.firecrawl.dev/v2/crawl/test-crawl-123?page=2", [], None)
        
        assert len(result) == 1  # Should have the first page data
        assert self.mock_client.get.call_count == 2


class TestBatchScrapePagination:
    """Test batch scrape pagination functionality."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = Mock()
        self.job_id = "test-batch-123"
        
        # Sample document data
        self.sample_doc = {
            "url": "https://example.com",
            "markdown": "# Test Content",
            "metadata": {
                "title": "Test Page",
                "statusCode": 200
            }
        }
    
    def test_get_batch_scrape_status_no_pagination(self):
        """Test get_batch_scrape_status with auto_paginate=False."""
        # Mock response with next URL
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 10,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2",
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.return_value = mock_response
        
        # Test with auto_paginate=False
        pagination_config = PaginationConfig(auto_paginate=False)
        result = get_batch_scrape_status(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2"
        assert len(result.data) == 1
        assert isinstance(result.data[0], Document)

    def test_get_batch_scrape_status_page(self):
        """Test get_batch_scrape_status_page returns a single page."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=3",
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response
        next_url = "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2"

        result = get_batch_scrape_status_page(self.mock_client, next_url)

        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=3"
        assert len(result.data) == 1
        self.mock_client.get.assert_called_with(next_url, timeout=None)

    def test_get_batch_scrape_status_page_propagates_request_timeout(self):
        """Ensure request_timeout is forwarded to batch status page requests."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        next_url = "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2"
        timeout_seconds = 2.7
        result = get_batch_scrape_status_page(
            self.mock_client,
            next_url,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_called_with(next_url, timeout=timeout_seconds)
    
    def test_get_batch_scrape_status_with_pagination(self):
        """Test get_batch_scrape_status with auto_paginate=True."""
        # Mock first page response
        mock_response1 = Mock()
        mock_response1.ok = True
        mock_response1.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2",
            "data": [self.sample_doc]
        }
        
        # Mock second page response
        mock_response2 = Mock()
        mock_response2.ok = True
        mock_response2.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 20,
            "total": 20,
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Test with auto_paginate=True
        pagination_config = PaginationConfig(auto_paginate=True)
        result = get_batch_scrape_status(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next is None  # Should be None when auto_paginate=True
        assert len(result.data) == 2
        assert self.mock_client.get.call_count == 2
    
    def test_fetch_all_batch_pages_limits(self):
        """Test _fetch_all_batch_pages with various limits."""
        # Mock responses for multiple pages
        mock_responses = []
        for i in range(5):  # 5 pages available
            mock_response = Mock()
            mock_response.ok = True
            mock_response.json.return_value = {
                "success": True,
                "data": [self.sample_doc, self.sample_doc],  # 2 docs per page
                "next": f"https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page={i+2}" if i < 4 else None
            }
            mock_responses.append(mock_response)
        
        self.mock_client.get.side_effect = mock_responses
        
        # Test with max_pages=2, max_results=4 (total docs we want)
        pagination_config = PaginationConfig(max_pages=2, max_results=4)
        result = _fetch_all_batch_pages(
            self.mock_client, 
            "https://api.firecrawl.dev/v2/batch/scrape/test-batch-123?page=2", 
            [Document(**self.sample_doc)],  # 1 initial doc
            pagination_config
        )
        
        # Should have 1 initial + 3 from pages (limited by max_results=4)
        assert len(result) == 4
        assert self.mock_client.get.call_count == 2  # Should fetch 2 pages


class TestAsyncPagination:
    """Test async pagination functionality."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = AsyncMock()
        self.job_id = "test-async-123"
        
        # Sample document data
        self.sample_doc = {
            "url": "https://example.com",
            "markdown": "# Test Content",
            "metadata": {
                "title": "Test Page",
                "statusCode": 200
            }
        }
    
    @pytest.mark.asyncio
    async def test_get_crawl_status_async_with_pagination(self):
        """Test async get_crawl_status with pagination."""
        # Mock first page response
        mock_response1 = Mock()
        mock_response1.status_code = 200
        mock_response1.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-async-123?page=2",
            "data": [self.sample_doc]
        }
        
        # Mock second page response
        mock_response2 = Mock()
        mock_response2.status_code = 200
        mock_response2.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 20,
            "total": 20,
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Test with auto_paginate=True
        pagination_config = PaginationConfig(auto_paginate=True)
        result = await get_crawl_status_async(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next is None
        assert len(result.data) == 2
        assert self.mock_client.get.call_count == 2

    @pytest.mark.asyncio
    async def test_get_crawl_status_async_propagates_request_timeout(self):
        """Ensure async request_timeout is forwarded to the HTTP client."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        timeout_seconds = 3.3
        import firecrawl.v2.methods.aio.crawl as crawl_module_async

        assert crawl_module_async.__file__.endswith("firecrawl/v2/methods/aio/crawl.py")
        assert crawl_module_async.get_crawl_status.__kwdefaults__ is not None
        assert "request_timeout" in crawl_module_async.get_crawl_status.__kwdefaults__
        result = await get_crawl_status_async(
            self.mock_client,
            self.job_id,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_awaited_with(
            f"/v2/crawl/{self.job_id}", timeout=timeout_seconds
        )

    @pytest.mark.asyncio
    async def test_get_crawl_status_page_async(self):
        """Test async get_crawl_status_page returns a single page."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/crawl/test-async-123?page=3",
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response
        next_url = "https://api.firecrawl.dev/v2/crawl/test-async-123?page=2"

        result = await get_crawl_status_page_async(self.mock_client, next_url)

        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/crawl/test-async-123?page=3"
        assert len(result.data) == 1
        self.mock_client.get.assert_awaited_with(next_url, timeout=None)

    @pytest.mark.asyncio
    async def test_get_crawl_status_page_async_propagates_request_timeout(self):
        """Ensure async request_timeout is forwarded to crawl status page requests."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        next_url = "https://api.firecrawl.dev/v2/crawl/test-async-123?page=2"
        timeout_seconds = 6.1
        result = await get_crawl_status_page_async(
            self.mock_client,
            next_url,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_awaited_with(next_url, timeout=timeout_seconds)

    @pytest.mark.asyncio
    async def test_get_batch_scrape_status_async_with_pagination(self):
        """Test async get_batch_scrape_status with pagination."""
        # Mock first page response
        mock_response1 = Mock()
        mock_response1.status_code = 200
        mock_response1.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/batch/scrape/test-async-123?page=2",
            "data": [self.sample_doc]
        }
        
        # Mock second page response
        mock_response2 = Mock()
        mock_response2.status_code = 200
        mock_response2.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 20,
            "total": 20,
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc]
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Test with auto_paginate=True
        pagination_config = PaginationConfig(auto_paginate=True)
        result = await get_batch_scrape_status_async(self.mock_client, self.job_id, pagination_config)
        
        assert result.status == "completed"
        assert result.next is None
        assert len(result.data) == 2
        assert self.mock_client.get.call_count == 2

    @pytest.mark.asyncio
    async def test_get_batch_scrape_status_page_async(self):
        """Test async get_batch_scrape_status_page returns a single page."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 10,
            "total": 20,
            "creditsUsed": 5,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": "https://api.firecrawl.dev/v2/batch/scrape/test-async-123?page=3",
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response
        next_url = "https://api.firecrawl.dev/v2/batch/scrape/test-async-123?page=2"

        result = await get_batch_scrape_status_page_async(self.mock_client, next_url)

        assert result.status == "completed"
        assert result.next == "https://api.firecrawl.dev/v2/batch/scrape/test-async-123?page=3"
        assert len(result.data) == 1
        self.mock_client.get.assert_awaited_with(next_url, timeout=None)

    @pytest.mark.asyncio
    async def test_get_batch_scrape_status_page_async_propagates_request_timeout(self):
        """Ensure async request_timeout is forwarded to batch status page requests."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 1,
            "total": 1,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": [self.sample_doc],
        }

        self.mock_client.get.return_value = mock_response

        next_url = "https://api.firecrawl.dev/v2/batch/scrape/test-async-123?page=2"
        timeout_seconds = 4.4
        result = await get_batch_scrape_status_page_async(
            self.mock_client,
            next_url,
            request_timeout=timeout_seconds,
        )

        assert result.status == "completed"
        self.mock_client.get.assert_awaited_with(next_url, timeout=timeout_seconds)
    
    @pytest.mark.asyncio
    async def test_fetch_all_pages_async_limits(self):
        """Test async _fetch_all_pages_async with limits."""
        # Mock responses for multiple pages
        mock_responses = []
        for i in range(3):  # 3 pages available
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.json.return_value = {
                "success": True,
                "data": [self.sample_doc],
                "next": f"https://api.firecrawl.dev/v2/crawl/test-async-123?page={i+2}" if i < 2 else None
            }
            mock_responses.append(mock_response)
        
        self.mock_client.get.side_effect = mock_responses
        
        # Test with max_pages=2
        pagination_config = PaginationConfig(max_pages=2)
        result = await _fetch_all_pages_async(
            self.mock_client,
            "https://api.firecrawl.dev/v2/crawl/test-async-123?page=2",
            [Document(**self.sample_doc)],  # 1 initial doc
            pagination_config
        )
        
        assert len(result) == 3  # 1 initial + 2 from pages
        assert self.mock_client.get.call_count == 2


class TestPaginationEdgeCases:
    """Test pagination edge cases and error conditions."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = Mock()
        self.sample_doc = {
            "url": "https://example.com",
            "markdown": "# Test Content",
            "metadata": {"title": "Test Page"}
        }
    
    def test_pagination_with_empty_data(self):
        """Test pagination when API returns empty data."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 0,
            "total": 0,
            "creditsUsed": 0,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": []
        }
        
        self.mock_client.get.return_value = mock_response
        
        pagination_config = PaginationConfig(auto_paginate=True)
        result = get_crawl_status(self.mock_client, "test-123", pagination_config)
        
        assert len(result.data) == 0
        assert result.next is None
    
    def test_pagination_with_string_data(self):
        """Test pagination when API returns string data (should be skipped)."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "completed": 2,
            "total": 2,
            "creditsUsed": 1,
            "expiresAt": "2024-01-01T00:00:00Z",
            "next": None,
            "data": ["https://example.com", self.sample_doc]  # String + dict
        }
        
        self.mock_client.get.return_value = mock_response
        
        pagination_config = PaginationConfig(auto_paginate=True)
        result = get_crawl_status(self.mock_client, "test-123", pagination_config)
        
        assert len(result.data) == 1  # Only the dict should be processed
        assert isinstance(result.data[0], Document)
    
    def test_pagination_with_failed_response(self):
        """Test pagination when API response indicates failure."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": False,
            "error": "Job not found"
        }
        
        self.mock_client.get.return_value = mock_response
        
        pagination_config = PaginationConfig(auto_paginate=True)
        
        with pytest.raises(Exception, match="Job not found"):
            get_crawl_status(self.mock_client, "test-123", pagination_config)
    
    def test_pagination_with_unsuccessful_page(self):
        """Test pagination when a subsequent page is unsuccessful."""
        # Mock first page success
        mock_response1 = Mock()
        mock_response1.ok = True
        mock_response1.json.return_value = {
            "success": True,
            "data": [self.sample_doc],
            "next": "https://api.firecrawl.dev/v2/crawl/test-123?page=2"
        }
        
        # Mock second page failure
        mock_response2 = Mock()
        mock_response2.ok = True
        mock_response2.json.return_value = {
            "success": False,
            "error": "Page not found"
        }
        
        self.mock_client.get.side_effect = [mock_response1, mock_response2]
        
        # Should continue with what we have
        result = _fetch_all_pages(self.mock_client, "https://api.firecrawl.dev/v2/crawl/test-123?page=2", [], None)
        
        assert len(result) == 1  # Should have the first page data
        assert self.mock_client.get.call_count == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
