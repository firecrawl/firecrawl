"""
Error handling utilities for v2 API.
"""

import requests
from typing import Dict, Any, Optional


class FirecrawlError(Exception):
    """Base exception for Firecrawl API errors."""
    
    def __init__(self, message: str, status_code: Optional[int] = None, response: Optional[requests.Response] = None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class BadRequestError(FirecrawlError):
    """Raised when the request is invalid (400)."""
    pass



class UnauthorizedError(FirecrawlError):
    """Raised when the request is unauthorized (401)."""
    pass


class PaymentRequiredError(FirecrawlError):
    """Raised when payment is required (402)."""
    pass


class WebsiteNotSupportedError(FirecrawlError):
    """Raised when website is not supported (403)."""
    pass


class RequestTimeoutError(FirecrawlError):
    """Raised when request times out (408)."""
    pass


class RateLimitError(FirecrawlError):
    """Raised when the rate limit is exceeded (429)."""
    pass


class InternalServerError(FirecrawlError):
    """Raised when there's an internal server error (500)."""
    pass


def handle_response_error(response: requests.Response, action: str) -> None:
    """
    Handle API response errors and raise appropriate exceptions.
    
    Args:
        response: The HTTP response object
        action: Description of the action being performed
        
    Raises:
        FirecrawlError: Appropriate error based on status code
    """
    try:
        response_json = response.json()
        error_message = response_json.get('error', 'No error message provided.')
        error_details = response_json.get('details', 'No additional error details provided.')
    except:
        # If we can't parse JSON, provide a helpful error message
        try:
            response_text = response.text[:500]  # Limit to first 500 chars
            if response_text.strip():
                error_message = f"Server returned non-JSON response: {response_text}"
                error_details = f"Full response status: {response.status_code}"
            else:
                error_message = f"Server returned empty response with status {response.status_code}"
                error_details = "No additional details available"
        except:
            error_message = f"Server returned unreadable response with status {response.status_code}"
            error_details = "No additional details available"
    
    # Create appropriate error message
    if response.status_code == 400:
        message = f"Bad Request: Failed to {action}. {error_message} - {error_details}"
        raise BadRequestError(message, response.status_code, response)
    elif response.status_code == 401:
        message = f"Unauthorized: Failed to {action}. {error_message} - {error_details}"
        raise UnauthorizedError(message, response.status_code, response)
    elif response.status_code == 402:
        message = f"Payment Required: Failed to {action}. {error_message} - {error_details}"
        raise PaymentRequiredError(message, response.status_code, response)
    elif response.status_code == 403:
        message = f"Website Not Supported: Failed to {action}. {error_message} - {error_details}"
        raise WebsiteNotSupportedError(message, response.status_code, response)
    elif response.status_code == 408:
        message = f"Request Timeout: Failed to {action} as the request timed out. {error_message} - {error_details}"
        raise RequestTimeoutError(message, response.status_code, response)
    elif response.status_code == 429:
        message = f"Rate Limit Exceeded: Failed to {action}. {error_message} - {error_details}"
        raise RateLimitError(message, response.status_code, response)
    elif response.status_code == 500:
        message = f"Internal Server Error: Failed to {action}. {error_message} - {error_details}"
        raise InternalServerError(message, response.status_code, response)
    else:
        message = f"Unexpected error during {action}: Status code {response.status_code}. {error_message} - {error_details}"
        raise FirecrawlError(message, response.status_code, response)