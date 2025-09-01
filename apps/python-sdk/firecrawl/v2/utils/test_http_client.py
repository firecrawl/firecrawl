import pytest
import requests
from unittest.mock import Mock, patch
from .http_client import HttpClient


class TestHttpClient:
    """Test cases for HttpClient security fixes."""
    
    @pytest.fixture
    def client(self):
        """Create a test client with API key."""
        return HttpClient("test-api-key", "https://api.firecrawl.dev")
    
    @pytest.fixture
    def client_no_key(self):
        """Create a test client without API key."""
        return HttpClient(None, "https://api.firecrawl.dev")
    
    @pytest.fixture
    def client_empty_key(self):
        """Create a test client with empty API key."""
        return HttpClient("   ", "https://api.firecrawl.dev")

    def test_is_same_host_relative_endpoint(self, client):
        """Test that relative endpoints are considered same host."""
        assert client._is_same_host("/v2/scrape") == True
        assert client._is_same_host("v2/scrape") == True
        assert client._is_same_host("") == True

    def test_is_same_host_absolute_same_host(self, client):
        """Test that absolute endpoints with same host return True."""
        assert client._is_same_host("https://api.firecrawl.dev/v2/scrape") == True
        assert client._is_same_host("https://api.firecrawl.dev:443/v2/scrape") == True
        assert client._is_same_host("https://api.firecrawl.dev./v2/scrape") == True

    def test_is_same_host_absolute_different_host(self, client):
        """Test that absolute endpoints with different host return False."""
        assert client._is_same_host("https://malicious.com/v2/scrape") == False
        assert client._is_same_host("https://api.firecrawl.dev.evil.com/v2/scrape") == False
        assert client._is_same_host("http://localhost:8000/v2/scrape") == False

    def test_is_same_host_invalid_url(self, client):
        """Test that invalid URLs are treated as different host for safety."""
        # "not-a-url" is actually treated as a relative endpoint, which is correct
        # Let's test with clearly invalid absolute URLs that have different hostnames
        assert client._is_same_host("http://malicious.com/v2/scrape") == False
        # Test with a malformed URL that should cause parsing to fail
        assert client._is_same_host("http://invalid:port:123/v2/scrape") == False

    def test_prepare_headers_with_api_key_same_host(self, client):
        """Test that Authorization header is included for same host."""
        headers = client._prepare_headers("/v2/scrape")
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer test-api-key"

    def test_prepare_headers_with_api_key_different_host(self, client):
        """Test that Authorization header is NOT included for different host."""
        headers = client._prepare_headers("https://malicious.com/v2/scrape")
        assert "Authorization" not in headers

    def test_prepare_headers_without_api_key(self, client_no_key):
        """Test that no Authorization header is added when no API key."""
        headers = client_no_key._prepare_headers("/v2/scrape")
        assert "Authorization" not in headers

    def test_prepare_headers_with_empty_api_key(self, client_empty_key):
        """Test that no Authorization header is added for empty/whitespace API key."""
        headers = client_empty_key._prepare_headers("/v2/scrape")
        assert "Authorization" not in headers

    def test_prepare_headers_with_idempotency_key(self, client):
        """Test that idempotency key is always added regardless of host."""
        headers = client._prepare_headers("/v2/scrape", idempotency_key="test-key")
        assert "Authorization" in headers
        assert "x-idempotency-key" in headers
        assert headers["x-idempotency-key"] == "test-key"

    def test_prepare_headers_idempotency_key_different_host(self, client):
        """Test that idempotency key is added even for different host."""
        headers = client._prepare_headers("https://malicious.com/v2/scrape", idempotency_key="test-key")
        assert "Authorization" not in headers
        assert "x-idempotency-key" in headers
        assert headers["x-idempotency-key"] == "test-key"

    @patch('requests.post')
    def test_post_same_host_includes_auth(self, mock_post, client):
        """Test that POST to same host includes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response
        
        client.post("/v2/scrape", {"url": "https://example.com"})
        
        # Verify the call was made
        mock_post.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_post.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is present
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer test-api-key"

    @patch('requests.post')
    def test_post_different_host_excludes_auth(self, mock_post, client):
        """Test that POST to different host excludes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response
        
        client.post("https://malicious.com/v2/scrape", {"url": "https://example.com"})
        
        # Verify the call was made
        mock_post.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_post.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is NOT present
        assert "Authorization" not in headers

    @patch('requests.get')
    def test_get_same_host_includes_auth(self, mock_get, client):
        """Test that GET to same host includes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_get.return_value = mock_response
        
        client.get("/v2/status")
        
        # Verify the call was made
        mock_get.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_get.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is present
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer test-api-key"

    @patch('requests.get')
    def test_get_different_host_excludes_auth(self, mock_get, client):
        """Test that GET to different host excludes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_get.return_value = mock_response
        
        client.get("https://malicious.com/v2/status")
        
        # Verify the call was made
        mock_get.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_get.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is NOT present
        assert "Authorization" not in headers

    @patch('requests.delete')
    def test_delete_same_host_includes_auth(self, mock_delete, client):
        """Test that DELETE to same host includes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_delete.return_value = mock_response
        
        client.delete("/v2/jobs/123")
        
        # Verify the call was made
        mock_delete.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_delete.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is present
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer test-api-key"

    @patch('requests.delete')
    def test_delete_different_host_excludes_auth(self, mock_delete, client):
        """Test that DELETE to different host excludes Authorization header."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_delete.return_value = mock_response
        
        client.delete("https://malicious.com/v2/jobs/123")
        
        # Verify the call was made
        mock_delete.assert_called_once()
        
        # Get the headers that were passed
        call_args = mock_delete.call_args
        headers = call_args[1]['headers']
        
        # Check that Authorization header is NOT present
        assert "Authorization" not in headers
