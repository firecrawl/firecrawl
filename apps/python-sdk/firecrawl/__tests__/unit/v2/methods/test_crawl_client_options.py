from unittest.mock import MagicMock

from firecrawl.v2.client import FirecrawlClient


def _client_with_recorded_post():
    client = FirecrawlClient(api_key="test-key", api_url="http://localhost")
    response = MagicMock()
    response.ok = True
    response.status_code = 200
    response.json.return_value = {"success": True, "id": "crawl-id", "url": "http://localhost/v2/crawl/crawl-id"}
    client.http_client = MagicMock()
    client.http_client.post.return_value = response
    return client


class TestCrawlClientOptionForwarding:
    """Client-level crawl methods must forward every crawl option to the request body."""

    def test_start_crawl_forwards_robots_user_agent(self):
        client = _client_with_recorded_post()

        client.start_crawl("https://example.com", robots_user_agent="MyBot")

        body = client.http_client.post.call_args[0][1]
        assert body["robotsUserAgent"] == "MyBot"

    def test_crawl_forwards_robots_user_agent(self, monkeypatch):
        client = _client_with_recorded_post()
        monkeypatch.setattr(
            "firecrawl.v2.methods.crawl.wait_for_crawl_completion",
            lambda *args, **kwargs: "done",
        )

        result = client.crawl("https://example.com", robots_user_agent="MyBot")

        body = client.http_client.post.call_args[0][1]
        assert body["robotsUserAgent"] == "MyBot"
        assert result == "done"

    def test_robots_user_agent_is_omitted_when_unset(self):
        client = _client_with_recorded_post()

        client.start_crawl("https://example.com")

        body = client.http_client.post.call_args[0][1]
        assert "robotsUserAgent" not in body
