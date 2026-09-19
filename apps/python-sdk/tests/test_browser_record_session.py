"""v2 browser.create should forward record_session (opt-out of session recording)."""
import unittest
from unittest.mock import MagicMock, patch

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.methods import browser as browser_module


def _ok_response(payload):
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.ok = True
    mock_response.json.return_value = {"success": True, **payload}
    return mock_response


class TestBrowserRecordSession(unittest.TestCase):
    def _client(self):
        return FirecrawlClient(api_key="dummy-api-key-for-testing")

    @patch("requests.post")
    def test_browser_forwards_record_session_false(self, mock_post):
        mock_post.return_value = _ok_response({"id": "sess_123"})
        client = self._client()

        client.browser(record_session=False)

        _, kwargs = mock_post.call_args
        self.assertIn("recordSession", kwargs["json"])
        self.assertIs(kwargs["json"]["recordSession"], False)

    @patch("requests.post")
    def test_browser_omits_record_session_by_default(self, mock_post):
        mock_post.return_value = _ok_response({"id": "sess_123"})
        client = self._client()

        client.browser(ttl=600)

        _, kwargs = mock_post.call_args
        self.assertNotIn("recordSession", kwargs["json"])

    def test_browser_module_forwards_record_session_false(self):
        client = MagicMock()
        client.post.return_value = _ok_response({"id": "sess_123"})

        browser_module.browser(client, record_session=False)

        sent_body = client.post.call_args[0][1]
        self.assertIs(sent_body.get("recordSession"), False)


if __name__ == "__main__":
    unittest.main()
