defmodule FirecrawlTest do
  use ExUnit.Case

  test "raises when no API key is configured" do
    old = Application.get_env(:firecrawl, :api_key)
    Application.delete_env(:firecrawl, :api_key)
    on_exit(fn -> if old, do: Application.put_env(:firecrawl, :api_key, old) end)

    assert_raise RuntimeError, ~r/Firecrawl API key not found/, fn ->
      Firecrawl.get_credit_usage()
    end
  end

  test "does not raise when API key is in application config" do
    Application.put_env(:firecrawl, :api_key, "test-config-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    result = Firecrawl.get_queue_status(base_url: "http://localhost:1", retry: false)
    assert {:error, _} = result
  end

  test "does not raise when API key is passed as option" do
    old = Application.get_env(:firecrawl, :api_key)
    Application.delete_env(:firecrawl, :api_key)
    on_exit(fn -> if old, do: Application.put_env(:firecrawl, :api_key, old) end)

    result =
      Firecrawl.get_queue_status(
        api_key: "test-opt-key",
        base_url: "http://localhost:1",
        retry: false
      )

    assert {:error, _} = result
  end

  test "non-bang returns {:error, _} for missing required params" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %NimbleOptions.ValidationError{}} =
             Firecrawl.scrape_and_extract_from_url([])
  end

  test "non-bang returns {:error, _} for unknown keys (typo detection)" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %NimbleOptions.ValidationError{message: msg}} =
             Firecrawl.scrape_and_extract_from_url(url: "https://example.com", typo_option: true)

    assert msg =~ "unknown options"
  end

  test "non-bang returns {:error, _} for wrong types" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %NimbleOptions.ValidationError{}} =
             Firecrawl.crawl_urls(url: "https://example.com", limit: "not an integer")
  end

  test "bang raises for missing required params" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert_raise NimbleOptions.ValidationError, ~r/required/, fn ->
      Firecrawl.scrape_and_extract_from_url!([])
    end
  end

  test "bang raises for unknown keys" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert_raise NimbleOptions.ValidationError, ~r/unknown options/, fn ->
      Firecrawl.scrape_and_extract_from_url!(url: "https://example.com", typo_option: true)
    end
  end

  test "create_monitor accepts a search target" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    result =
      Firecrawl.create_monitor(
        [
          name: "search monitor",
          schedule: [interval: "24h"],
          goal: "Track new mentions",
          judge_enabled: true,
          targets: [
            [
              type: "search",
              queries: ["firecrawl"],
              search_window: "24h",
              include_domains: ["example.com"],
              exclude_domains: [],
              max_results: 10
            ]
          ]
        ],
        base_url: "http://localhost:1",
        retry: false
      )

    # Validation passes (it is not a ValidationError); the request itself fails
    # because the base_url is unreachable.
    assert {:error, error} = result
    refute match?(%NimbleOptions.ValidationError{}, error)
  end

  test "accepts atom values for enum params" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    result =
      Firecrawl.crawl_urls(
        [url: "https://example.com", sitemap: :skip],
        base_url: "http://localhost:1",
        retry: false
      )

    assert {:error, _} = result
  end

  test "accepts string values for enum params (model)" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    result =
      Firecrawl.start_agent(
        [prompt: "test", model: "spark-1-mini"],
        base_url: "http://localhost:1",
        retry: false
      )

    assert {:error, err} = result
    refute match?(%NimbleOptions.ValidationError{}, err),
      "Expected connection error, got validation error: #{inspect(err)}"
  end

  test "accepts string values for enum params (sitemap)" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    result =
      Firecrawl.crawl_urls(
        [url: "https://example.com", sitemap: "skip"],
        base_url: "http://localhost:1",
        retry: false
      )

    assert {:error, err} = result
    refute match?(%NimbleOptions.ValidationError{}, err),
      "Expected connection error, got validation error: #{inspect(err)}"
  end

  test "parse_file returns error tuple when filename is empty" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %ArgumentError{message: msg}} =
             Firecrawl.parse_file([filename: "", data: "x"])

    assert msg =~ "filename cannot be empty"
  end

  test "parse_file returns error tuple when data is nil" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %ArgumentError{message: msg}} =
             Firecrawl.parse_file([filename: "doc.pdf", data: nil])

    assert msg =~ "file data cannot be empty"
  end

  test "parse_file rejects unknown options" do
    Application.put_env(:firecrawl, :api_key, "test-key")
    on_exit(fn -> Application.delete_env(:firecrawl, :api_key) end)

    assert {:error, %NimbleOptions.ValidationError{message: msg}} =
             Firecrawl.parse_file(
               [filename: "doc.pdf", data: "x"],
               typo_option: true
             )

    assert msg =~ "unknown options"
  end

  test "non-bang returns {:error, %Firecrawl.Error{}} for API errors" do
    adapter = fn request ->
      resp = Req.Response.new(
        status: 402,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => false, "error" => "Payment required"})
      )
      {request, resp}
    end

    result =
      Firecrawl.scrape_and_extract_from_url(
        [url: "https://example.com"],
        api_key: "test-key",
        adapter: adapter
      )

    assert {:error, %Firecrawl.Error{status: 402}} = result
  end

  test "bang raises Firecrawl.Error for API errors" do
    adapter = fn request ->
      resp = Req.Response.new(
        status: 401,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => false, "error" => "Unauthorized"})
      )
      {request, resp}
    end

    assert_raise Firecrawl.Error, ~r/Unauthorized/, fn ->
      Firecrawl.scrape_and_extract_from_url!(
        [url: "https://example.com"],
        api_key: "test-key",
        adapter: adapter
      )
    end
  end

  test "non-bang returns {:ok, response} for successful API calls" do
    adapter = fn request ->
      resp = Req.Response.new(
        status: 200,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => true, "data" => %{}})
      )
      {request, resp}
    end

    result =
      Firecrawl.get_credit_usage(
        api_key: "test-key",
        adapter: adapter
      )

    assert {:ok, %Req.Response{status: 200}} = result
  end

  test "scrape maps redact_pii to redactPII" do
    parent = self()

    adapter = fn request ->
      send(parent, {:request, request})

      resp = Req.Response.new(
        status: 200,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => true, "data" => %{}})
      )

      {request, resp}
    end

    assert {:ok, %Req.Response{status: 200}} =
             Firecrawl.scrape_and_extract_from_url(
               [url: "https://example.com", redact_pii: true],
               api_key: "test-key",
               adapter: adapter
             )

    assert_receive {:request, request}

    body =
      cond do
        is_binary(request.body) -> Jason.decode!(request.body)
        is_map(request.body) -> request.body
        true -> request.options[:json]
      end

    assert body["redactPII"] == true
    refute Map.has_key?(body, "formats")
  end

  test "batch scrape maps redact_pii to redactPII" do
    parent = self()

    adapter = fn request ->
      send(parent, {:request, request})

      resp = Req.Response.new(
        status: 200,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => true, "id" => "batch-id"})
      )

      {request, resp}
    end

    assert {:ok, %Req.Response{status: 200}} =
             Firecrawl.scrape_and_extract_from_urls(
               [urls: ["https://example.com"], redact_pii: true],
               api_key: "test-key",
               adapter: adapter
             )

    assert_receive {:request, request}

    body =
      cond do
        is_binary(request.body) -> Jason.decode!(request.body)
        is_map(request.body) -> request.body
        true -> request.options[:json]
      end

    assert body["redactPII"] == true
    assert body["urls"] == ["https://example.com"]
  end

  test "search maps highlights to highlights" do
    parent = self()

    adapter = fn request ->
      send(parent, {:request, request})

      resp = Req.Response.new(
        status: 200,
        headers: %{"content-type" => ["application/json"]},
        body: Jason.encode!(%{"success" => true, "data" => %{}})
      )

      {request, resp}
    end

    assert {:ok, %Req.Response{status: 200}} =
             Firecrawl.search_and_scrape(
               [query: "firecrawl", highlights: false],
               api_key: "test-key",
               adapter: adapter
             )

    assert_receive {:request, request}

    body =
      cond do
        is_binary(request.body) -> Jason.decode!(request.body)
        is_map(request.body) -> request.body
        true -> request.options[:json]
      end

    assert body["highlights"] == false
  end

  test "all expected API functions are defined with bang variants" do
    functions = Firecrawl.__info__(:functions)

    expected = [
      {:scrape_and_extract_from_url, 0},
      {:scrape_and_extract_from_url, 1},
      {:scrape_and_extract_from_url, 2},
      {:scrape_and_extract_from_url!, 0},
      {:scrape_and_extract_from_url!, 1},
      {:scrape_and_extract_from_url!, 2},
      {:crawl_urls, 0},
      {:crawl_urls!, 0},
      {:get_credit_usage, 0},
      {:get_credit_usage!, 0},
      {:get_queue_status, 0},
      {:get_queue_status!, 0},
      {:cancel_crawl, 1},
      {:cancel_crawl!, 1},
      {:parse_file, 1},
      {:parse_file, 2},
      {:parse_file, 3},
      {:parse_file!, 1},
      {:parse_file!, 2},
      {:parse_file!, 3}
    ]

    for {name, arity} <- expected do
      assert {name, arity} in functions,
             "Expected #{name}/#{arity} to be defined in Firecrawl"
    end
  end
end
