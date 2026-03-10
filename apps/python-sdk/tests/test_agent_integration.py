"""
Integration tests for agent method with mocked requests.
"""

import unittest
from unittest.mock import patch, MagicMock
from pydantic import BaseModel, Field
from typing import List, Optional

from firecrawl import FirecrawlApp


class Founder(BaseModel):
    name: str = Field(description="Full name of the founder")
    role: Optional[str] = Field(None, description="Role or position")
    background: Optional[str] = Field(None, description="Professional background")


class FoundersSchema(BaseModel):
    founders: List[Founder] = Field(description="List of founders")


class TestAgent(unittest.TestCase):
    """Integration tests for agent method."""

    @patch('firecrawl.v2.utils.http_client.requests.post')
    @patch('firecrawl.v2.utils.http_client.requests.get')
    def test_agent_basic(self, mock_get, mock_post):
        """Test basic agent call."""
        # Mock start agent response
        mock_start_response = MagicMock()
        mock_start_response.ok = True
        mock_start_response.status_code = 200
        mock_start_response.json.return_value = {
            "success": True,
            "id": "test-agent-123",
            "status": "processing"
        }
        mock_post.return_value = mock_start_response
        
        # Mock get status response (completed)
        mock_status_response = MagicMock()
        mock_status_response.ok = True
        mock_status_response.status_code = 200
        mock_status_response.json.return_value = {
            "success": True,
            "id": "test-agent-123",
            "status": "completed",
            "data": {
                "founders": [
                    {"name": "John Doe", "role": "CEO", "background": "Tech entrepreneur"},
                    {"name": "Jane Smith", "role": "CTO", "background": "Software engineer"}
                ]
            },
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z"
        }
        mock_get.return_value = mock_status_response
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(
            prompt="Find the founders of Firecrawl",
            schema=FoundersSchema
        )
        
        # Verify post was called with correct URL and data
        mock_post.assert_called_once()
        post_call_args = mock_post.call_args
        post_url = post_call_args[1]["url"] if "url" in post_call_args[1] else post_call_args[0][0]
        assert "/v2/agent" in str(post_url)
        
        # Check request body
        request_body = post_call_args[1]["json"]
        assert request_body["prompt"] == "Find the founders of Firecrawl"
        assert "schema" in request_body
        assert request_body["schema"]["type"] == "object"
        assert "founders" in request_body["schema"]["properties"]
        
        # Verify get was called to check status
        mock_get.assert_called()
        
        # Check result
        assert result.status == "completed"
        assert result.data is not None

    @patch('firecrawl.v2.utils.http_client.requests.post')
    def test_agent_with_urls(self, mock_post):
        """Test agent call with URLs."""
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_post.return_value = mock_response
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(
            urls=["https://example.com", "https://test.com"],
            prompt="Extract information",
            schema={"type": "object", "properties": {"info": {"type": "string"}}}
        )
        
        # Check request body includes URLs
        post_call_args = mock_post.call_args
        request_body = post_call_args[1]["json"]
        assert request_body["urls"] == ["https://example.com", "https://test.com"]
        assert request_body["prompt"] == "Extract information"

    @patch('firecrawl.v2.utils.http_client.requests.post')
    def test_agent_with_dict_schema(self, mock_post):
        """Test agent call with dict schema."""
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_post.return_value = mock_response
        
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"}
            }
        }
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(
            prompt="Extract person data",
            schema=schema
        )
        
        # Check request body includes schema
        post_call_args = mock_post.call_args
        request_body = post_call_args[1]["json"]
        assert request_body["schema"] == schema

    @patch('firecrawl.v2.utils.http_client.requests.post')
    def test_agent_with_all_params(self, mock_post):
        """Test agent call with all parameters."""
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_post.return_value = mock_response
        
        schema = {"type": "object"}
        urls = ["https://example.com"]
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(
            urls=urls,
            prompt="Complete test",
            schema=schema,
            integration="test-integration",
            max_credits=50,
            strict_constrain_to_urls=True,
            poll_interval=1,
            timeout=30
        )
        
        # Check all parameters are in request body
        post_call_args = mock_post.call_args
        request_body = post_call_args[1]["json"]
        assert request_body["prompt"] == "Complete test"
        assert request_body["urls"] == urls
        assert request_body["schema"] == schema
        assert request_body["integration"] == "test-integration"
        assert request_body["maxCredits"] == 50
        assert request_body["strictConstrainToURLs"] is True

    @patch('firecrawl.v2.utils.http_client.requests.post')
    def test_agent_pydantic_schema_normalization(self, mock_post):
        """Test that Pydantic schemas are properly normalized."""
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_post.return_value = mock_response
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(
            prompt="Find founders",
            schema=FoundersSchema
        )
        
        # Check that schema was normalized to JSON schema format
        post_call_args = mock_post.call_args
        request_body = post_call_args[1]["json"]
        assert "schema" in request_body
        schema = request_body["schema"]
        assert schema["type"] == "object"
        assert "properties" in schema
        assert "founders" in schema["properties"]
        assert schema["properties"]["founders"]["type"] == "array"

    @patch('firecrawl.v2.utils.http_client.requests.post')
    @patch('firecrawl.v2.utils.http_client.requests.get')
    def test_agent_url_construction(self, mock_get, mock_post):
        """Test that agent requests are sent to correct URL."""
        # Mock start agent response
        mock_start_response = MagicMock()
        mock_start_response.ok = True
        mock_start_response.status_code = 200
        mock_start_response.json.return_value = {
            "success": True,
            "id": "test-agent-123",
            "status": "processing"
        }
        mock_post.return_value = mock_start_response
        
        # Mock get status response
        mock_status_response = MagicMock()
        mock_status_response.ok = True
        mock_status_response.status_code = 200
        mock_status_response.json.return_value = {
            "success": True,
            "id": "test-agent-123",
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_get.return_value = mock_status_response
        
        app = FirecrawlApp(api_key="test-api-key", api_url="https://api.firecrawl.dev")
        result = app.agent(prompt="Test prompt")
        
        # Check POST URL - requests.post is called with url as keyword arg
        post_call_args = mock_post.call_args
        post_url = post_call_args[1].get("url") if "url" in post_call_args[1] else post_call_args[0][0]
        assert "/v2/agent" in str(post_url)
        
        # Check GET URL
        get_call_args = mock_get.call_args
        get_url = get_call_args[1].get("url") if "url" in get_call_args[1] else get_call_args[0][0]
        assert "/v2/agent/test-agent-123" in str(get_url)

    @patch('firecrawl.v2.utils.http_client.requests.post')
    def test_agent_headers(self, mock_post):
        """Test that agent requests include correct headers."""
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        mock_post.return_value = mock_response
        
        app = FirecrawlApp(api_key="test-api-key")
        result = app.agent(prompt="Test prompt")
        
        # Check headers
        post_call_args = mock_post.call_args
        headers = post_call_args[1]["headers"]
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer test-api-key"
        assert headers["Content-Type"] == "application/json"


if __name__ == '__main__':
    unittest.main()

