defmodule Firecrawl.ApiOriginTest do
  use ExUnit.Case, async: true

  alias Firecrawl.ApiOrigin

  @api_url "https://api.firecrawl.dev/v2"

  test "keeps same-origin URLs" do
    assert ApiOrigin.pin("https://api.firecrawl.dev/v2/crawl/abc?skip=10", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc?skip=10"
  end

  test "rewrites a foreign host onto the api_url origin" do
    assert ApiOrigin.pin("https://evil.example/v2/crawl/abc?skip=10", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc?skip=10"
  end

  test "drops userinfo from a foreign URL" do
    assert ApiOrigin.pin("https://user:pass@evil.example/v2/crawl/abc?skip=10", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc?skip=10"
  end

  test "accepts a URI struct as api_url" do
    assert ApiOrigin.pin("https://evil.example/v2/crawl/abc", URI.parse(@api_url)) ==
             "https://api.firecrawl.dev/v2/crawl/abc"
  end

  test "rewrites protocol-relative URLs" do
    assert ApiOrigin.pin("//evil.example/v2/crawl/abc?skip=10", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc?skip=10"
  end

  test "rewrites a different port" do
    assert ApiOrigin.pin("https://api.firecrawl.dev:8443/v2/crawl/abc", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc"

    assert ApiOrigin.pin("https://evil.example/v2/crawl/abc", "http://localhost:3002/v2") ==
             "http://localhost:3002/v2/crawl/abc"
  end

  test "rewrites a different scheme" do
    assert ApiOrigin.pin("http://api.firecrawl.dev/v2/crawl/abc", @api_url) ==
             "https://api.firecrawl.dev/v2/crawl/abc"
  end

  test "preserves path and query and drops the fragment" do
    assert ApiOrigin.pin(
             "https://evil.example/v2/batch/scrape/abc?skip=10&limit=5#frag",
             @api_url
           ) ==
             "https://api.firecrawl.dev/v2/batch/scrape/abc?skip=10&limit=5"

    assert ApiOrigin.pin("https://evil.example", @api_url) == "https://api.firecrawl.dev/"
  end

  test "returns relative URLs unchanged" do
    assert ApiOrigin.pin("/v2/crawl/abc?skip=10", @api_url) == "/v2/crawl/abc?skip=10"
  end

  test "raises when api_url is not absolute" do
    assert_raise ArgumentError, ~r/api_url must be an absolute URL/, fn ->
      ApiOrigin.pin("https://evil.example/v2/crawl/abc", "/v2")
    end

    assert_raise ArgumentError, ~r/api_url must be an absolute URL/, fn ->
      ApiOrigin.pin("https://evil.example/v2/crawl/abc", fn -> @api_url end)
    end
  end
end
