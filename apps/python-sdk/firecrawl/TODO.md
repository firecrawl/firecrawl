- [ ] improve error handling for 500s


============================================================================ FAILURES ============================================================================
_____________________________________________________ TestCrawlE2E.test_get_active_crawls_with_running_crawl _____________________________________________________

self = <test_crawl.TestCrawlE2E object at 0x1039a5810>

    def test_get_active_crawls_with_running_crawl(self):
        """Test getting active crawls when there's a running crawl."""
        # Start a crawl
        start_job = self.client.start_crawl("https://docs.firecrawl.dev", limit=5)
        assert start_job.id is not None
    
        # Get active crawls
>       active_crawls_response = self.client.active_crawls()
                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^

firecrawl/__tests__/e2e/v2/test_crawl.py:149: 
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ 
firecrawl/v2/client.py:386: in active_crawls
    return self.get_active_crawls()
           ^^^^^^^^^^^^^^^^^^^^^^^^
firecrawl/v2/client.py:377: in get_active_crawls
    return crawl_module.get_active_crawls(self.http_client)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
firecrawl/v2/methods/crawl.py:446: in get_active_crawls
    handle_response_error(response, "get active crawls")
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ 

response = <Response [500]>, action = 'get active crawls'

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
>           raise InternalServerError(message, response.status_code, response)
E           firecrawl.v2.utils.error_handler.InternalServerError: Internal Server Error: Failed to get active crawls. An unexpected error occurred. Please contact help@firecrawl.com for help. Your exception ID is c775af539e3a44f286664e55c488638e - No additional error details provided.

firecrawl/v2/utils/error_handler.py:104: InternalServerError
==================================================================== short test summary info =====================================================================
FAILED firecrawl/__tests__/e2e/v2/test_crawl.py::TestCrawlE2E::test_get_active_crawls_with_running_crawl - firecrawl.v2.utils.error_handler.InternalServerError: Internal Server Error: Failed to get active crawls. An unexpected error occurred. Please contact help@f...
======================================================================= 1 failed in 1.17s ========================================================================
