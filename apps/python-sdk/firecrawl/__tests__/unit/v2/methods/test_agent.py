"""
Unit tests for agent methods with mocked HTTP client.
"""

import pytest  # type: ignore[import-not-found]
import time
from unittest.mock import Mock, patch
from pydantic import BaseModel, Field  # type: ignore[import-not-found]
from typing import List, Optional

from firecrawl.v2.methods.agent import (
    start_agent,
    agent,
    get_agent_status,
    cancel_agent,
    wait_agent
)
from firecrawl.v2.types import AgentResponse
from firecrawl.v2.utils.error_handler import BadRequestError


class TestAgentMethods:
    """Unit tests for agent methods with mocked HTTP client."""

    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = Mock()
        self.job_id = "test-agent-123"
        
        # Sample agent response
        self.sample_response = {
            "success": True,
            "id": self.job_id,
            "status": "completed",
            "data": {
                "founders": [
                    {"name": "John Doe", "role": "CEO"},
                    {"name": "Jane Smith", "role": "CTO"}
                ]
            },
            "creditsUsed": 10,
            "expiresAt": "2024-01-01T00:00:00Z"
        }

    def test_start_agent_basic(self):
        """Test starting an agent job with basic parameters."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.post.return_value = mock_response
        
        result = start_agent(
            self.mock_client,
            None,
            prompt="Find information about Firecrawl"
        )
        
        # Check that post was called with correct endpoint
        self.mock_client.post.assert_called_once()
        call_args = self.mock_client.post.call_args
        assert call_args[0][0] == "/v2/agent"
        
        # Check request body (second positional argument)
        body = call_args[0][1]
        assert body["prompt"] == "Find information about Firecrawl"
        assert "urls" not in body
        
        # Check result
        assert isinstance(result, AgentResponse)
        assert result.id == self.job_id
        assert result.status == "processing"

    def test_start_agent_with_zero_data_retention(self):
        """Test starting an agent job with zero data retention."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }

        self.mock_client.post.return_value = mock_response

        result = start_agent(
            self.mock_client,
            None,
            prompt="Find information about Firecrawl",
            zero_data_retention=True
        )

        call_args = self.mock_client.post.call_args
        body = call_args[0][1]
        assert body["zeroDataRetention"] is True
        assert result.id == self.job_id

    def test_start_agent_with_urls(self):
        """Test starting an agent job with URLs."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.post.return_value = mock_response
        
        urls = ["https://example.com", "https://test.com"]
        result = start_agent(
            self.mock_client,
            urls,
            prompt="Extract data"
        )
        
        call_args = self.mock_client.post.call_args
        body = call_args[0][1]
        assert body["urls"] == urls

    def test_start_agent_with_dict_schema(self):
        """Test starting an agent job with dict schema."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.post.return_value = mock_response
        
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        
        result = start_agent(
            self.mock_client,
            None,
            prompt="Extract data",
            schema=schema
        )
        
        call_args = self.mock_client.post.call_args
        body = call_args[0][1]
        assert body["schema"] == schema

    def test_start_agent_with_pydantic_schema(self):
        """Test starting an agent job with Pydantic schema."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.post.return_value = mock_response
        
        class Founder(BaseModel):
            name: str = Field(description="Full name")
            role: Optional[str] = Field(None, description="Role")
        
        class FoundersSchema(BaseModel):
            founders: List[Founder] = Field(description="List of founders")
        
        result = start_agent(
            self.mock_client,
            None,
            prompt="Find founders",
            schema=FoundersSchema
        )
        
        call_args = self.mock_client.post.call_args
        body = call_args[0][1]
        assert "schema" in body
        assert body["schema"]["type"] == "object"
        assert "founders" in body["schema"]["properties"]

    def test_start_agent_with_all_params(self):
        """Test starting an agent job with all parameters."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.post.return_value = mock_response
        
        schema = {"type": "object"}
        urls = ["https://example.com"]
        
        result = start_agent(
            self.mock_client,
            urls,
            prompt="Complete test",
            schema=schema,
            integration="test-integration",
            max_credits=50,
            zero_data_retention=True,
            strict_constrain_to_urls=True
        )
        
        call_args = self.mock_client.post.call_args
        body = call_args[0][1]
        assert body["prompt"] == "Complete test"
        assert body["urls"] == urls
        assert body["schema"] == schema
        assert body["integration"] == "test-integration"
        assert body["maxCredits"] == 50
        assert body["zeroDataRetention"] is True
        assert body["strictConstrainToURLs"] is True

    def test_get_agent_status(self):
        """Test getting agent status."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = self.sample_response
        
        self.mock_client.get.return_value = mock_response
        
        result = get_agent_status(self.mock_client, self.job_id)
        
        # Check that get was called with correct endpoint
        self.mock_client.get.assert_called_once_with(f"/v2/agent/{self.job_id}")
        
        # Check result
        assert isinstance(result, AgentResponse)
        assert result.id == self.job_id
        assert result.status == "completed"

    def test_cancel_agent(self):
        """Test canceling an agent job."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {"success": True}
        
        self.mock_client.delete.return_value = mock_response
        
        result = cancel_agent(self.mock_client, self.job_id)
        
        # Check that delete was called with correct endpoint
        self.mock_client.delete.assert_called_once_with(f"/v2/agent/{self.job_id}")
        
        # Check result
        assert result is True

    @patch('time.sleep')
    def test_wait_agent_completed(self, mock_sleep):
        """Test waiting for agent to complete."""
        # First call returns processing, second returns completed
        mock_response_processing = Mock()
        mock_response_processing.ok = True
        mock_response_processing.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        mock_response_completed = Mock()
        mock_response_completed.ok = True
        mock_response_completed.json.return_value = self.sample_response
        
        self.mock_client.get.side_effect = [
            mock_response_processing,
            mock_response_completed
        ]
        
        result = wait_agent(self.mock_client, self.job_id, poll_interval=1)
        
        # Should have called get twice
        assert self.mock_client.get.call_count == 2
        assert result.status == "completed"
        assert mock_sleep.call_count == 1

    @patch('time.sleep')
    def test_wait_agent_timeout(self, mock_sleep):
        """Test waiting for agent with timeout."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        self.mock_client.get.return_value = mock_response
        
        # Mock time.time to simulate timeout
        with patch('time.time', side_effect=[0, 0, 5]):  # Start at 0, timeout at 5
            result = wait_agent(
                self.mock_client,
                self.job_id,
                poll_interval=1,
                timeout=3  # Timeout after 3 seconds
            )
        
        # Should return processing status due to timeout
        assert result.status == "processing"

    @patch('time.sleep')
    def test_agent_complete_flow(self, mock_sleep):
        """Test the complete agent flow (start + wait)."""
        # Mock start_agent response
        mock_start_response = Mock()
        mock_start_response.ok = True
        mock_start_response.json.return_value = {
            "success": True,
            "id": self.job_id,
            "status": "processing"
        }
        
        # Mock get_agent_status responses
        mock_status_response = Mock()
        mock_status_response.ok = True
        mock_status_response.json.return_value = self.sample_response
        
        self.mock_client.post.return_value = mock_start_response
        self.mock_client.get.return_value = mock_status_response
        
        result = agent(
            self.mock_client,
            None,
            prompt="Find information",
            poll_interval=1
        )
        
        # Should have called post once and get once
        assert self.mock_client.post.call_count == 1
        assert self.mock_client.get.call_count == 1
        
        # Check result
        assert isinstance(result, AgentResponse)
        assert result.status == "completed"
        assert result.data is not None

    def test_agent_immediate_completion(self):
        """Test agent that completes immediately (no job ID)."""
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "success": True,
            "status": "completed",
            "data": {"result": "done"}
        }
        
        self.mock_client.post.return_value = mock_response
        
        result = agent(
            self.mock_client,
            None,
            prompt="Quick task"
        )
        
        # Should only call post, not get
        assert self.mock_client.post.call_count == 1
        assert self.mock_client.get.call_count == 0
        assert result.status == "completed"

    def test_start_agent_error_handling(self):
        """Test error handling in start_agent."""
        mock_response = Mock()
        mock_response.ok = False
        mock_response.status_code = 400
        mock_response.text = "Bad Request"
        # Mock response.json() to return error details
        mock_response.json.return_value = {
            "error": "Invalid request",
            "details": "Bad Request"
        }
        
        self.mock_client.post.return_value = mock_response
        
        with pytest.raises(BadRequestError) as exc_info:
            start_agent(
                self.mock_client,
                None,
                prompt="Test prompt"
            )
        
        # Verify the exception has the correct status code
        assert exc_info.value.status_code == 400
        assert "agent" in str(exc_info.value).lower()
