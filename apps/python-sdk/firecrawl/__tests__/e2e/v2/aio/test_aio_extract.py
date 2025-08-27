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
async def test_async_extract_minimal():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    res = await client.extract(urls=["https://docs.firecrawl.dev"], prompt="Extract title")
    assert res is not None


@pytest.mark.asyncio
async def test_async_extract_with_schema_and_options():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    res = await client.extract(
        urls=["https://docs.firecrawl.dev"],
        prompt="Extract title",
        schema=schema,
        system_prompt="You are a helpful extractor",
        allow_external_links=False,
        enable_web_search=False,
        show_sources=False,
        # agent={"model": "FIRE-1", "prompt": "Extract title"}, # Skipping agent test in CI
    )
    assert res is not None

