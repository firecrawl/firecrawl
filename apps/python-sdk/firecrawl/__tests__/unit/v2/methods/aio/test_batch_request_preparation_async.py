from firecrawl.v2.types import ScrapeOptions, Location
from firecrawl.v2.methods.aio.batch import _prepare as _prepare_batch


class TestAsyncBatchRequestPreparation:
    def test_urls_validation_and_conversion(self):
        payload = _prepare_batch(["https://example.com", "http://foo.bar"], options=None)
        assert payload["urls"] == ["https://example.com", "http://foo.bar"]

    def test_options_and_batch_fields(self):
        opts = ScrapeOptions(formats=["markdown"], only_main_content=True)
        payload = _prepare_batch(
            ["https://example.com"],
            options=opts,
            webhook="https://hook.example",
            append_to_id="00000000-0000-0000-0000-000000000000",
            ignore_invalid_urls=True,
            max_concurrency=3,
            zero_data_retention=True,
            integration="zapier",
        )
        assert payload["webhook"] == "https://hook.example"
        assert payload["appendToId"] == "00000000-0000-0000-0000-000000000000"
        assert payload["ignoreInvalidURLs"] is True
        assert payload["maxConcurrency"] == 3
        assert payload["zeroDataRetention"] is True
        assert payload["integration"] == "zapier"

