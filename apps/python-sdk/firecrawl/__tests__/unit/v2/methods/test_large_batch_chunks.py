from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import pytest

from firecrawl.v2.methods.batch import chunk_urls, process_large_batch
from firecrawl.v2.types import Document


@pytest.mark.parametrize("chunk_size", [0, -1, -100])
@pytest.mark.parametrize("urls", [[], ["https://example.com"]])
def test_chunk_urls_rejects_nonpositive_size(urls, chunk_size):
    with pytest.raises(ValueError, match="chunk_size must be positive"):
        chunk_urls(urls, chunk_size)


@pytest.mark.parametrize("chunk_size", [0, -1, -100])
def test_large_batch_rejects_nonpositive_size_before_starting_jobs(chunk_size):
    client = Mock()
    with patch("firecrawl.v2.methods.batch.batch_scrape") as scrape:
        with pytest.raises(ValueError, match="chunk_size must be positive"):
            process_large_batch(client, ["https://example.com"], chunk_size=chunk_size)
    scrape.assert_not_called()
    assert client.mock_calls == []


def test_large_batch_processes_every_url_in_order():
    client = Mock()
    urls = [f"https://example.com/{index}" for index in range(5)]
    documents = [Document(markdown=str(index)) for index in range(5)]
    with patch(
        "firecrawl.v2.methods.batch.batch_scrape",
        side_effect=[
            SimpleNamespace(data=documents[:2]),
            SimpleNamespace(data=documents[2:4]),
            SimpleNamespace(data=documents[4:]),
        ],
    ) as scrape:
        result = process_large_batch(
            client, urls, chunk_size=2, poll_interval=3, timeout=60
        )
    assert result == documents
    assert scrape.call_args_list == [
        call(client, urls[:2], options=None, poll_interval=3, timeout=60),
        call(client, urls[2:4], options=None, poll_interval=3, timeout=60),
        call(client, urls[4:], options=None, poll_interval=3, timeout=60),
    ]


def test_chunk_urls_keeps_default_and_empty_input_behavior():
    urls = [f"https://example.com/{index}" for index in range(101)]
    assert chunk_urls(urls) == [urls[:100], urls[100:]]
    assert chunk_urls([], 1) == []
