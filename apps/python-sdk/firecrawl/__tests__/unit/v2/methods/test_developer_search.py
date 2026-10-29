from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import DeveloperSearchLicenseDisclosure


RESPONSE = {
    "success": True,
    "results": [
        {
            "id": "issue:firecrawl/firecrawl#1",
            "url": "https://github.com/firecrawl/firecrawl/issues/1",
            "passages": [
                {
                    "text": "evidence",
                    "citation_url": "https://github.com/firecrawl/firecrawl/issues/1#issuecomment-1",
                }
            ],
            "license": {"state": "licensed", "spdx_id": "MIT"},
        }
    ],
    "repos": [
        {
            "repo": "firecrawl/firecrawl",
            "indexed": True,
            "types": {"issue": True, "pullRequest": True, "readme": True},
        }
    ],
    "sources": [{"source": "firecrawl", "indexed": False}],
}


def _response(payload=RESPONSE):
    response = Mock()
    response.status_code = 200
    response.json.return_value = payload
    return response


def _options():
    return {
        "k": 20,
        "passages": 5,
        "types": ["doc", "issue", "pull_request", "readme"],
        "repos": ["firecrawl/firecrawl"],
        "sources": ["firecrawl"],
        "language": "TypeScript",
        "topic": ["web-scraping"],
        "license": "MIT",
        "min_stars": 100,
        "max_stars": 50000,
        "archived": False,
        "fork": True,
        "skills": "only",
    }


EXPECTED_REQUEST = {"query": "retry configuration", **_options()}


def test_developer_search_forwards_all_filters_and_parses_evidence():
    transport = Mock()
    transport.post.return_value = _response()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    result = client.developer_search("retry configuration", **_options())

    transport.post.assert_called_once_with("/v2/search/developer", EXPECTED_REQUEST)
    assert result.results[0].passages[0].citation_url.endswith("issuecomment-1")
    assert isinstance(result.results[0].license, DeveloperSearchLicenseDisclosure)
    assert result.results[0].license.spdx_id == "MIT"
    assert result.repos[0].types.pull_request is True
    assert result.sources[0].indexed is False


def test_developer_search_accepts_flattened_spdx_license():
    payload = {
        **RESPONSE,
        "results": [{**RESPONSE["results"][0], "license": "MIT"}],
    }
    transport = Mock()
    transport.post.return_value = _response(payload)
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    result = client.developer_search("license shape")

    assert result.results[0].license == "MIT"


@pytest.mark.asyncio
async def test_async_developer_search_forwards_all_filters():
    transport = Mock()
    transport.post = AsyncMock(return_value=_response())
    client = AsyncFirecrawlClient.__new__(AsyncFirecrawlClient)
    client.async_http_client = transport

    result = await client.developer_search("retry configuration", **_options())

    transport.post.assert_awaited_once_with("/v2/search/developer", EXPECTED_REQUEST)
    assert result.results[0].id == "issue:firecrawl/firecrawl#1"
