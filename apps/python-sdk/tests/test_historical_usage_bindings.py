from firecrawl import Firecrawl, AsyncFirecrawl


def test_unified_client_historical_usage_bindings():
    sync_client = Firecrawl(api_key="test-key")
    assert hasattr(sync_client, "get_credit_usage_historical")
    assert hasattr(sync_client, "get_token_usage_historical")
    assert sync_client.get_credit_usage_historical == sync_client._v2_client.get_credit_usage_historical
    assert sync_client.get_token_usage_historical == sync_client._v2_client.get_token_usage_historical

    async_client = AsyncFirecrawl(api_key="test-key")
    assert hasattr(async_client, "get_credit_usage_historical")
    assert hasattr(async_client, "get_token_usage_historical")
    assert async_client.get_credit_usage_historical == async_client._v2_client.get_credit_usage_historical
    assert async_client.get_token_usage_historical == async_client._v2_client.get_token_usage_historical
