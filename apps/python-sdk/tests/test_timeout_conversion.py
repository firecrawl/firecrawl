import unittest
from unittest.mock import patch, MagicMock
import os
from firecrawl import FirecrawlApp


class TestTimeoutConversion(unittest.TestCase):
    
    @patch('requests.post')
    def test_scrape_url_timeout_conversion(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'success': True,
            'data': {
                'markdown': 'Test content'
            }
        }
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        app.scrape_url('https://example.com', timeout=60000)

        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 65.0)

    @patch('requests.post')
    def test_scrape_url_default_timeout(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'success': True,
            'data': {
                'markdown': 'Test content'
            }
        }
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        app.scrape_url('https://example.com')

        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 35.0)

    @patch('requests.post')
    def test_post_request_timeout_conversion(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        
        data = {'timeout': 30000}
        headers = {'Content-Type': 'application/json'}
        
        app._post_request('https://example.com/api', data, headers)

        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 35.0)

    @patch('requests.post')
    def test_post_request_default_timeout(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        
        data = {'timeout': 30000, 'url': 'https://example.com'}
        headers = {'Content-Type': 'application/json'}
        
        app._post_request('https://example.com/api', data, headers)

        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 35.0)

    @patch('requests.post')
    def test_timeout_edge_cases(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'success': True,
            'data': {
                'markdown': 'Test content'
            }
        }
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        
        app.scrape_url('https://example.com', timeout=1000)
        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 6.0)
        
        app.scrape_url('https://example.com', timeout=0)
        args, kwargs = mock_post.call_args
        self.assertEqual(kwargs['timeout'], 5.0)

    @patch('requests.post')
    def test_post_request_no_timeout_key(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response

        app = FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'dummy-api-key-for-testing'))
        
        data = {'url': 'https://example.com'}
        headers = {'Content-Type': 'application/json'}
        
        app._post_request('https://example.com/api', data, headers)

        args, kwargs = mock_post.call_args
        self.assertIsNone(kwargs['timeout'])


if __name__ == '__main__':
    unittest.main()
