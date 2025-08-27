import os
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_get_concurrency():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    conc = await client.get_concurrency()
    assert hasattr(conc, "concurrency") and hasattr(conc, "max_concurrency")


@pytest.mark.asyncio
async def test_async_get_credit_usage():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    credits = await client.get_credit_usage()
    assert hasattr(credits, "remaining_credits")


@pytest.mark.asyncio
async def test_async_get_token_usage():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    tokens = await client.get_token_usage()
    assert hasattr(tokens, "remaining_tokens")

