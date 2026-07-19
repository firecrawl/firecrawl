# frozen_string_literal: true

require_relative "../test_helper"

class ClientTest < Minitest::Test
  API_KEY = "fc-test-key"
  BASE_URL = "https://api.firecrawl.dev"

  def setup
    WebMock.reset!
    @client = Firecrawl::Client.new(api_key: API_KEY)
  end

  # ================================================================
  # CLIENT INITIALIZATION
  # ================================================================

  def test_allows_no_api_key_for_keyless_endpoints
    ENV.delete("FIRECRAWL_API_KEY")
    assert_instance_of Firecrawl::Client, Firecrawl::Client.new
  end

  def test_allows_whitespace_only_api_key_for_keyless_endpoints
    ENV.delete("FIRECRAWL_API_KEY")
    assert_instance_of Firecrawl::Client, Firecrawl::Client.new(api_key: "   ")
  end

  def test_raises_when_api_url_not_http
    assert_raises(Firecrawl::FirecrawlError) { Firecrawl::Client.new(api_key: API_KEY, api_url: "ftp://bad.host") }
  end

  def test_raises_when_api_url_has_no_scheme
    assert_raises(Firecrawl::FirecrawlError) { Firecrawl::Client.new(api_key: API_KEY, api_url: "not-a-url") }
  end

  def test_from_env_with_env_var
    ENV["FIRECRAWL_API_KEY"] = "fc-env-key"
    client = Firecrawl::Client.from_env
    assert_instance_of Firecrawl::Client, client
  ensure
    ENV.delete("FIRECRAWL_API_KEY")
  end

  def test_custom_api_url
    stub_request(:post, "https://custom.api.dev/v2/scrape")
      .to_return(status: 200, body: '{"data":{"markdown":"# Hi"}}', headers: { "Content-Type" => "application/json" })

    client = Firecrawl::Client.new(api_key: API_KEY, api_url: "https://custom.api.dev")
    doc = client.scrape("https://example.com")
    assert_equal "# Hi", doc.markdown
  end

  def test_custom_api_url_from_env
    ENV["FIRECRAWL_API_URL"] = "https://env-custom.api.dev"
    stub_request(:post, "https://env-custom.api.dev/v2/scrape")
      .to_return(status: 200, body: '{"data":{"markdown":"# Env"}}', headers: { "Content-Type" => "application/json" })

    client = Firecrawl::Client.new(api_key: API_KEY)
    doc = client.scrape("https://example.com")
    assert_equal "# Env", doc.markdown
  ensure
    ENV.delete("FIRECRAWL_API_URL")
  end

  # ================================================================
  # SCRAPE
  # ================================================================

  def test_scrape_basic
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .with(
        body: { url: "https://example.com", origin: "ruby-sdk@#{Firecrawl::VERSION}" }.to_json,
        headers: { "Authorization" => "Bearer #{API_KEY}", "Content-Type" => "application/json" }
      )
      .to_return(
        status: 200,
        body: JSON.generate(data: { markdown: "# Hello", video: "https://storage.googleapis.com/firecrawl/video.mp4", metadata: { title: "Example", sourceURL: "https://example.com" } }),
        headers: { "Content-Type" => "application/json" }
      )

    doc = @client.scrape("https://example.com")
    assert_instance_of Firecrawl::Models::Document, doc
    assert_equal "# Hello", doc.markdown
    assert_equal "https://storage.googleapis.com/firecrawl/video.mp4", doc.video
    assert_equal "Example", doc.metadata["title"]
  end

  def test_scrape_with_options
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .with { |req| body = JSON.parse(req.body); body["formats"] == ["markdown", "html"] && body["onlyMainContent"] == true }
      .to_return(
        status: 200,
        body: JSON.generate(data: { markdown: "# Test", html: "<h1>Test</h1>" }),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::ScrapeOptions.new(formats: ["markdown", "html"], only_main_content: true)
    doc = @client.scrape("https://example.com", options)
    assert_equal "# Test", doc.markdown
    assert_equal "<h1>Test</h1>", doc.html
  end

  def test_scrape_raises_on_nil_url
    assert_raises(ArgumentError) { @client.scrape(nil) }
  end

  def test_scrape_with_product_format
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 200,
        body: JSON.generate(
          data: {
            markdown: "# Widget",
            product: {
              title: "Acme Widget",
              brand: "Acme",
              category: "Gadgets",
              url: "https://example.com/widget",
              description: "A fine widget.",
              variants: [
                {
                  id: "v1",
                  sku: "ACME-1",
                  title: "Large",
                  values: { size: "L" },
                  price: { amount: 2199, currency: "USD" },
                  sale: { originalPrice: { amount: 2999, currency: "USD", formatted: "$29.99" } },
                  availability: { inStock: true, text: "In stock" },
                  images: [{ url: "https://example.com/v1.jpg", alt: "Widget" }],
                },
                {
                  id: "v2",
                  title: "Small",
                  values: { size: "S" },
                },
              ],
            },
          }
        ),
        headers: { "Content-Type" => "application/json" }
      )

    doc = @client.scrape("https://example.com/widget")
    product = doc.product
    assert_instance_of Firecrawl::Models::ProductProfile, product
    assert_equal "Acme Widget", product.title
    assert_equal "Acme", product.brand
    assert_equal "Gadgets", product.category
    assert_equal "https://example.com/widget", product.url
    assert_equal "A fine widget.", product.description

    assert_equal 2, product.variants.size
    variant = product.variants.first
    assert_equal "v1", variant.id
    assert_equal "ACME-1", variant.sku
    assert_equal "Large", variant.title
    assert_equal({ "size" => "L" }, variant.values)

    assert_equal 2199, variant.price.amount
    assert_equal "USD", variant.price.currency

    assert_equal 2999, variant.sale.original_price.amount
    assert_equal "$29.99", variant.sale.original_price.formatted

    assert_equal true, variant.availability.in_stock
    assert_equal "In stock", variant.availability.text

    assert_equal 1, variant.images.size
    assert_equal "https://example.com/v1.jpg", variant.images.first.url
    assert_equal "Widget", variant.images.first.alt

    # Availability is always present; sale/price/images are optional.
    bare = product.variants.last
    assert_equal "v2", bare.id
    assert_nil bare.price
    assert_nil bare.sale
    refute_nil bare.availability
    assert_equal false, bare.availability.in_stock
    assert_empty bare.images
  end

  def test_scrape_without_product_format_leaves_product_nil
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 200,
        body: JSON.generate(data: { markdown: "# Hi" }),
        headers: { "Content-Type" => "application/json" }
      )

    doc = @client.scrape("https://example.com")
    assert_nil doc.product
  end

  def test_scrape_with_menu_format
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 200,
        body: JSON.generate(
          data: {
            markdown: "# Menu",
            menu: {
              isMenu: true,
              confidence: 0.92,
              currency: "USD",
              sourceUrl: "https://example.com/menu",
              merchant: {
                name: "Joe's Diner",
                type: "restaurant",
                location: { city: "Springfield" },
              },
              sections: [
                {
                  id: "s1",
                  name: "Breakfast",
                  description: "Served all day.",
                  items: [
                    {
                      id: "i1",
                      name: "Pancakes",
                      description: "Fluffy stack.",
                      images: [{ url: "https://example.com/pancakes.jpg", alt: "Pancakes" }],
                      price: { amount: 899, currency: "USD", formatted: "$8.99" },
                      availability: { inStock: true, text: "Available" },
                      dietary: ["vegetarian"],
                      calories: 520,
                      optionGroups: [{ name: "Syrup" }],
                      identifiers: { merchantItemId: "MENU-1" },
                      url: "https://example.com/menu#pancakes",
                      sourceUrl: "https://example.com/menu",
                    },
                    {
                      id: "i2",
                      name: "Toast",
                      sourceUrl: "https://example.com/menu",
                    },
                  ],
                },
              ],
            },
          }
        ),
        headers: { "Content-Type" => "application/json" }
      )

    doc = @client.scrape("https://example.com/menu")
    menu = doc.menu
    assert_instance_of Firecrawl::Models::MenuProfile, menu
    assert_equal true, menu.is_menu
    assert_in_delta 0.92, menu.confidence, 0.0001
    assert_equal "USD", menu.currency
    assert_equal "https://example.com/menu", menu.source_url

    assert_equal "Joe's Diner", menu.merchant.name
    assert_equal "restaurant", menu.merchant.type
    assert_equal({ "city" => "Springfield" }, menu.merchant.location)

    assert_equal 1, menu.sections.size
    section = menu.sections.first
    assert_equal "s1", section.id
    assert_equal "Breakfast", section.name
    assert_equal "Served all day.", section.description

    assert_equal 2, section.items.size
    item = section.items.first
    assert_equal "i1", item.id
    assert_equal "Pancakes", item.name
    assert_equal "Fluffy stack.", item.description

    assert_equal 1, item.images.size
    assert_equal "https://example.com/pancakes.jpg", item.images.first.url
    assert_equal "Pancakes", item.images.first.alt

    assert_equal 899, item.price.amount
    assert_equal "USD", item.price.currency
    assert_equal "$8.99", item.price.formatted

    assert_equal true, item.availability.in_stock
    assert_equal "Available", item.availability.text

    assert_equal ["vegetarian"], item.dietary
    assert_equal 520, item.calories
    assert_equal [{ "name" => "Syrup" }], item.option_groups
    assert_equal "MENU-1", item.identifiers.merchant_item_id
    assert_equal "https://example.com/menu#pancakes", item.url
    assert_equal "https://example.com/menu", item.source_url

    # price/images/calories optional; availability always present.
    bare = section.items.last
    assert_equal "i2", bare.id
    assert_nil bare.price
    assert_nil bare.calories
    assert_empty bare.images
    assert_empty bare.dietary
    assert_empty bare.option_groups
    refute_nil bare.availability
    assert_equal false, bare.availability.in_stock
    assert_nil bare.identifiers.merchant_item_id
  end

  def test_scrape_without_menu_format_leaves_menu_nil
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 200,
        body: JSON.generate(data: { markdown: "# Hi" }),
        headers: { "Content-Type" => "application/json" }
      )

    doc = @client.scrape("https://example.com")
    assert_nil doc.menu
  end

  # ================================================================
  # CRAWL
  # ================================================================

  def test_start_crawl
    stub_request(:post, "#{BASE_URL}/v2/crawl")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-123", url: "https://api.firecrawl.dev/v2/crawl/crawl-123"),
        headers: { "Content-Type" => "application/json" }
      )

    response = @client.start_crawl("https://example.com")
    assert_instance_of Firecrawl::Models::CrawlResponse, response
    assert_equal "crawl-123", response.id
  end

  def test_get_crawl_status
    stub_request(:get, "#{BASE_URL}/v2/crawl/crawl-123")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-123", status: "completed", total: 5, completed: 5, data: []),
        headers: { "Content-Type" => "application/json" }
      )

    job = @client.get_crawl_status("crawl-123")
    assert_instance_of Firecrawl::Models::CrawlJob, job
    assert_equal "completed", job.status
    assert job.done?
  end

  def test_crawl_with_polling
    # First call: start crawl
    stub_request(:post, "#{BASE_URL}/v2/crawl")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-poll"),
        headers: { "Content-Type" => "application/json" }
      )

    # Second call: status is scraping (in progress)
    stub_request(:get, "#{BASE_URL}/v2/crawl/crawl-poll")
      .to_return(
        { status: 200, body: JSON.generate(id: "crawl-poll", status: "scraping", total: 2, completed: 1, data: []), headers: { "Content-Type" => "application/json" } },
        { status: 200, body: JSON.generate(id: "crawl-poll", status: "completed", total: 2, completed: 2, data: [{ markdown: "# Page" }]), headers: { "Content-Type" => "application/json" } }
      )

    job = @client.crawl("https://example.com", nil, poll_interval: 0, timeout: 10)
    assert_equal "completed", job.status
    assert_equal 1, job.data.size
    assert_equal "# Page", job.data.first.markdown
  end

  def test_crawl_with_options
    stub_request(:post, "#{BASE_URL}/v2/crawl")
      .with { |req| body = JSON.parse(req.body); body["limit"] == 10 && body["excludePaths"] == ["/private"] }
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-opts"),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "#{BASE_URL}/v2/crawl/crawl-opts")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-opts", status: "completed", total: 1, completed: 1, data: []),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::CrawlOptions.new(limit: 10, exclude_paths: ["/private"])
    job = @client.crawl("https://example.com", options, poll_interval: 0, timeout: 10)
    assert_equal "completed", job.status
  end

  def test_cancel_crawl
    stub_request(:delete, "#{BASE_URL}/v2/crawl/crawl-cancel")
      .to_return(
        status: 200,
        body: JSON.generate(status: "cancelled"),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.cancel_crawl("crawl-cancel")
    assert_equal "cancelled", result["status"]
  end

  # ================================================================
  # BATCH SCRAPE
  # ================================================================

  def test_start_batch_scrape
    stub_request(:post, "#{BASE_URL}/v2/batch/scrape")
      .to_return(
        status: 200,
        body: JSON.generate(id: "batch-123", url: "https://api.firecrawl.dev/v2/batch/scrape/batch-123"),
        headers: { "Content-Type" => "application/json" }
      )

    response = @client.start_batch_scrape(["https://a.com", "https://b.com"])
    assert_instance_of Firecrawl::Models::BatchScrapeResponse, response
    assert_equal "batch-123", response.id
  end

  def test_batch_scrape_with_idempotency_key
    stub_request(:post, "#{BASE_URL}/v2/batch/scrape")
      .with(headers: { "x-idempotency-key" => "my-key" })
      .to_return(
        status: 200,
        body: JSON.generate(id: "batch-idem"),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "#{BASE_URL}/v2/batch/scrape/batch-idem")
      .to_return(
        status: 200,
        body: JSON.generate(id: "batch-idem", status: "completed", total: 1, completed: 1, data: []),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::BatchScrapeOptions.new(idempotency_key: "my-key")
    job = @client.batch_scrape(["https://a.com"], options, poll_interval: 0, timeout: 10)
    assert_equal "completed", job.status
  end

  # ================================================================
  # MAP
  # ================================================================

  def test_map_basic
    stub_request(:post, "#{BASE_URL}/v2/map")
      .to_return(
        status: 200,
        body: JSON.generate(data: { links: ["https://example.com/a", "https://example.com/b"] }),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.map("https://example.com")
    assert_instance_of Firecrawl::Models::MapData, result
    assert_equal 2, result.links.size
    assert_equal "https://example.com/a", result.links.first["url"]
  end

  def test_map_with_object_links
    stub_request(:post, "#{BASE_URL}/v2/map")
      .to_return(
        status: 200,
        body: JSON.generate(data: { links: [{ url: "https://example.com/a", title: "Page A" }] }),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.map("https://example.com")
    assert_equal "https://example.com/a", result.links.first["url"]
    assert_equal "Page A", result.links.first["title"]
  end

  def test_map_with_options
    stub_request(:post, "#{BASE_URL}/v2/map")
      .with { |req| body = JSON.parse(req.body); body["limit"] == 50 && body["search"] == "blog" }
      .to_return(
        status: 200,
        body: JSON.generate(data: { links: [] }),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::MapOptions.new(limit: 50, search: "blog")
    result = @client.map("https://example.com", options)
    assert_equal 0, result.links.size
  end

  # ================================================================
  # SEARCH
  # ================================================================

  def test_search_basic
    stub_request(:post, "#{BASE_URL}/v2/search")
      .to_return(
        status: 200,
        body: JSON.generate(data: { web: [{ url: "https://example.com", title: "Example" }] }),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.search("test query")
    assert_instance_of Firecrawl::Models::SearchData, result
    assert_equal 1, result.web.size
    assert_equal "https://example.com", result.web.first["url"]
  end

  def test_search_with_options
    stub_request(:post, "#{BASE_URL}/v2/search")
      .with { |req| body = JSON.parse(req.body); body["limit"] == 5 && body["location"] == "US" }
      .to_return(
        status: 200,
        body: JSON.generate(data: { web: [], news: [], images: [] }),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::SearchOptions.new(limit: 5, location: "US")
    result = @client.search("test query", options)
    assert_equal 0, result.web.size
  end

  # ================================================================
  # AGENT
  # ================================================================

  def test_start_agent
    stub_request(:post, "#{BASE_URL}/v2/agent")
      .to_return(
        status: 200,
        body: JSON.generate(success: true, id: "agent-123"),
        headers: { "Content-Type" => "application/json" }
      )

    options = Firecrawl::Models::AgentOptions.new(prompt: "Find pricing info")
    response = @client.start_agent(options)
    assert_instance_of Firecrawl::Models::AgentResponse, response
    assert_equal "agent-123", response.id
    assert_equal true, response.success
  end

  def test_agent_with_polling
    stub_request(:post, "#{BASE_URL}/v2/agent")
      .to_return(
        status: 200,
        body: JSON.generate(success: true, id: "agent-poll"),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "#{BASE_URL}/v2/agent/agent-poll")
      .to_return(
        { status: 200, body: JSON.generate(status: "processing"), headers: { "Content-Type" => "application/json" } },
        { status: 200, body: JSON.generate(status: "completed", data: { result: "found" }), headers: { "Content-Type" => "application/json" } }
      )

    options = Firecrawl::Models::AgentOptions.new(prompt: "Find pricing info")
    status = @client.agent(options, poll_interval: 0, timeout: 10)
    assert_equal "completed", status.status
    assert_equal({ "result" => "found" }, status.data)
  end

  def test_agent_options_require_prompt
    assert_raises(ArgumentError) { Firecrawl::Models::AgentOptions.new(prompt: "") }
    assert_raises(ArgumentError) { Firecrawl::Models::AgentOptions.new }
  end

  # ================================================================
  # USAGE & METRICS
  # ================================================================

  def test_get_concurrency
    stub_request(:get, "#{BASE_URL}/v2/concurrency-check")
      .to_return(
        status: 200,
        body: JSON.generate(concurrency: 3, maxConcurrency: 10),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.get_concurrency
    assert_instance_of Firecrawl::Models::ConcurrencyCheck, result
    assert_equal 3, result.concurrency
    assert_equal 10, result.max_concurrency
  end

  def test_get_credit_usage
    stub_request(:get, "#{BASE_URL}/v2/team/credit-usage")
      .to_return(
        status: 200,
        body: JSON.generate(success: true, data: { remainingCredits: 500, planCredits: 1000 }),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.get_credit_usage
    assert_instance_of Firecrawl::Models::CreditUsage, result
    assert_equal 500, result.remaining_credits
    assert_equal 1000, result.plan_credits
  end

  # ================================================================
  # ERROR HANDLING
  # ================================================================

  def test_authentication_error
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 401,
        body: JSON.generate(error: "Invalid API key"),
        headers: { "Content-Type" => "application/json" }
      )

    error = assert_raises(Firecrawl::AuthenticationError) { @client.scrape("https://example.com") }
    assert_equal 401, error.status_code
    assert_equal "Invalid API key", error.message
  end

  def test_rate_limit_error
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 429,
        body: JSON.generate(error: "Rate limit exceeded"),
        headers: { "Content-Type" => "application/json" }
      )

    error = assert_raises(Firecrawl::RateLimitError) { @client.scrape("https://example.com") }
    assert_equal 429, error.status_code
  end

  def test_client_error
    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        status: 400,
        body: JSON.generate(error: "Bad request"),
        headers: { "Content-Type" => "application/json" }
      )

    error = assert_raises(Firecrawl::FirecrawlError) { @client.scrape("https://example.com") }
    assert_equal 400, error.status_code
    assert_equal "Bad request", error.message
  end

  def test_retryable_server_error
    # Client is configured with max_retries=3, but let's use a client with 1 retry for speed
    client = Firecrawl::Client.new(api_key: API_KEY, max_retries: 1, backoff_factor: 0.0)

    stub_request(:post, "#{BASE_URL}/v2/scrape")
      .to_return(
        { status: 502, body: JSON.generate(error: "Bad gateway"), headers: { "Content-Type" => "application/json" } },
        { status: 200, body: JSON.generate(data: { markdown: "# Recovered" }), headers: { "Content-Type" => "application/json" } }
      )

    doc = client.scrape("https://example.com")
    assert_equal "# Recovered", doc.markdown
  end

  # ================================================================
  # OPTIONS SERIALIZATION
  # ================================================================

  def test_scrape_options_to_h
    opts = Firecrawl::Models::ScrapeOptions.new(
      formats: ["markdown", "html"],
      only_main_content: true,
      wait_for: 1000,
      mobile: false,
      proxy: "stealth",
      redact_pii: true
    )
    h = opts.to_h
    assert_equal ["markdown", "html"], h["formats"]
    assert_equal true, h["onlyMainContent"]
    assert_equal 1000, h["waitFor"]
    assert_equal false, h["mobile"]
    assert_equal "stealth", h["proxy"]
    assert_equal true, h["redactPII"]
    assert_equal false, h["skipTlsVerification"] # defaults to false
    refute h.key?("timeout") # nil values should be omitted
  end

  def test_query_format_to_h
    format = Firecrawl::Models::QueryFormat.new(
      prompt: "What is Firecrawl?",
      mode: Firecrawl::Models::QueryFormat::MODE_DIRECT_QUOTE
    )
    opts = Firecrawl::Models::ScrapeOptions.new(formats: [format])

    assert_equal(
      [{ "type" => "query", "prompt" => "What is Firecrawl?", "mode" => "directQuote" }],
      opts.to_h["formats"]
    )
  end

  def test_question_and_highlights_format_to_h
    question = Firecrawl::Models::QuestionFormat.new(question: "What is Firecrawl?")
    highlights = Firecrawl::Models::HighlightsFormat.new(query: "What is Firecrawl?")
    opts = Firecrawl::Models::ScrapeOptions.new(formats: [question, highlights])

    assert_equal(
      [
        { "type" => "question", "question" => "What is Firecrawl?" },
        { "type" => "highlights", "query" => "What is Firecrawl?" },
      ],
      opts.to_h["formats"]
    )
  end

  def test_query_format_rejects_invalid_mode
    assert_raises(ArgumentError) do
      Firecrawl::Models::QueryFormat.new(prompt: "What is Firecrawl?", mode: "quoted")
    end
  end

  def test_scrape_options_skip_tls_defaults_to_false
    opts = Firecrawl::Models::ScrapeOptions.new
    assert_equal false, opts.skip_tls_verification
    assert_equal false, opts.to_h["skipTlsVerification"]
  end

  def test_scrape_options_skip_tls_can_be_overridden_to_false
    opts = Firecrawl::Models::ScrapeOptions.new(skip_tls_verification: false)
    assert_equal false, opts.skip_tls_verification
    assert_equal false, opts.to_h["skipTlsVerification"]
  end

  def test_crawl_options_to_h
    opts = Firecrawl::Models::CrawlOptions.new(
      limit: 100,
      exclude_paths: ["/private"],
      max_discovery_depth: 3,
      allow_external_links: false
    )
    h = opts.to_h
    assert_equal 100, h["limit"]
    assert_equal ["/private"], h["excludePaths"]
    assert_equal 3, h["maxDiscoveryDepth"]
    assert_equal false, h["allowExternalLinks"]
  end

  def test_map_options_to_h
    opts = Firecrawl::Models::MapOptions.new(
      search: "blog",
      limit: 50,
      sitemap: "include"
    )
    h = opts.to_h
    assert_equal "blog", h["search"]
    assert_equal 50, h["limit"]
    assert_equal "include", h["sitemap"]
  end

  def test_search_options_to_h
    opts = Firecrawl::Models::SearchOptions.new(
      limit: 10,
      location: "US",
      tbs: "qdr:w",
      highlights: false,
      include_domains: ["firecrawl.dev"],
      exclude_domains: ["example.com"]
    )
    h = opts.to_h
    assert_equal 10, h["limit"]
    assert_equal "US", h["location"]
    assert_equal "qdr:w", h["tbs"]
    assert_equal false, h["highlights"]
    assert_equal ["firecrawl.dev"], h["includeDomains"]
    assert_equal ["example.com"], h["excludeDomains"]
  end

  def test_agent_options_to_h
    opts = Firecrawl::Models::AgentOptions.new(
      prompt: "Find data",
      urls: ["https://example.com"],
      max_credits: 100,
      model: "spark-1-pro"
    )
    h = opts.to_h
    assert_equal "Find data", h["prompt"]
    assert_equal ["https://example.com"], h["urls"]
    assert_equal 100, h["maxCredits"]
    assert_equal "spark-1-pro", h["model"]
  end

  def test_batch_scrape_options_to_h
    scrape_opts = Firecrawl::Models::ScrapeOptions.new(formats: ["markdown"])
    opts = Firecrawl::Models::BatchScrapeOptions.new(
      options: scrape_opts,
      max_concurrency: 5,
      zero_data_retention: true
    )
    h = opts.to_h
    assert_equal({ "formats" => ["markdown"], "skipTlsVerification" => false }, h["options"])
    assert_equal 5, h["maxConcurrency"]
    assert_equal true, h["zeroDataRetention"]
  end

  # ================================================================
  # PAGINATION
  # ================================================================

  def test_crawl_auto_pagination
    stub_request(:post, "#{BASE_URL}/v2/crawl")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-pag"),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "#{BASE_URL}/v2/crawl/crawl-pag")
      .to_return(
        status: 200,
        body: JSON.generate(
          id: "crawl-pag", status: "completed", total: 2, completed: 2,
          data: [{ markdown: "# Page 1" }],
          next: "https://api.firecrawl.dev/v2/crawl/crawl-pag?skip=1"
        ),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "https://api.firecrawl.dev/v2/crawl/crawl-pag?skip=1")
      .to_return(
        status: 200,
        body: JSON.generate(
          id: "crawl-pag", status: "completed", total: 2, completed: 2,
          data: [{ markdown: "# Page 2" }]
        ),
        headers: { "Content-Type" => "application/json" }
      )

    job = @client.crawl("https://example.com", nil, poll_interval: 0, timeout: 10)
    assert_equal 2, job.data.size
    assert_equal "# Page 1", job.data[0].markdown
    assert_equal "# Page 2", job.data[1].markdown
  end

  def test_crawl_pagination_rejects_third_party_url
    stub_request(:post, "#{BASE_URL}/v2/crawl")
      .to_return(
        status: 200,
        body: JSON.generate(id: "crawl-leak"),
        headers: { "Content-Type" => "application/json" }
      )

    stub_request(:get, "#{BASE_URL}/v2/crawl/crawl-leak")
      .to_return(
        status: 200,
        body: JSON.generate(
          id: "crawl-leak", status: "completed", total: 1, completed: 1,
          data: [{ markdown: "# Page 1" }],
          next: "https://evil.example.com/steal?token=yes"
        ),
        headers: { "Content-Type" => "application/json" }
      )

    assert_raises(Firecrawl::FirecrawlError) do
      @client.crawl("https://example.com", nil, poll_interval: 0, timeout: 10)
    end
  end

  # ================================================================
  # INTERACT
  # ================================================================

  def test_interact
    stub_request(:post, "#{BASE_URL}/v2/scrape/job-123/interact")
      .with { |req| body = JSON.parse(req.body); body["code"] == "console.log('hi')" && body["language"] == "node" }
      .to_return(
        status: 200,
        body: JSON.generate(stdout: "hi\n", stderr: "", exitCode: 0),
        headers: { "Content-Type" => "application/json" }
      )

    result = @client.interact("job-123", "console.log('hi')")
    assert_equal "hi\n", result["stdout"]
    assert_equal 0, result["exitCode"]
  end

  # ================================================================
  # PARSE
  # ================================================================

  def test_parse_options_to_h
    opts = Firecrawl::Models::ParseOptions.new(
      formats: ["markdown"],
      only_main_content: true,
      timeout: 30000,
      proxy: "auto",
      redact_pii: true
    )
    h = opts.to_h
    assert_equal ["markdown"], h["formats"]
    assert_equal true, h["onlyMainContent"]
    assert_equal 30000, h["timeout"]
    assert_equal "auto", h["proxy"]
    assert_equal true, h["redactPII"]
  end

  def test_parse_options_rejects_unsupported_format
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseOptions.new(formats: ["screenshot"])
    end
  end

  def test_parse_options_rejects_video_format
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseOptions.new(formats: ["video"])
    end
  end

  def test_parse_options_rejects_product_format
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseOptions.new(formats: ["product"])
    end
  end

  def test_parse_options_rejects_menu_format
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseOptions.new(formats: ["menu"])
    end
  end

  def test_parse_options_rejects_invalid_proxy
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseOptions.new(proxy: "stealth")
    end
  end

  def test_parse_file_rejects_empty_content
    assert_raises(ArgumentError) do
      Firecrawl::Models::ParseFile.new(filename: "doc.pdf", content: "")
    end
  end

  def test_parse_sends_multipart_request
    stub_request(:post, "#{BASE_URL}/v2/parse")
      .with { |req|
        req.headers["Content-Type"].to_s.start_with?("multipart/form-data") &&
          req.body.include?('name="options"') &&
          req.body.include?('name="file"; filename="doc.html"') &&
          req.body.include?("<html>hi</html>")
      }
      .to_return(
        status: 200,
        body: JSON.generate(success: true, data: { markdown: "# Parsed", metadata: { sourceURL: "file://doc.html" } }),
        headers: { "Content-Type" => "application/json" }
      )

    file = Firecrawl::Models::ParseFile.new(
      filename: "doc.html",
      content: "<html>hi</html>",
      content_type: "text/html"
    )
    doc = @client.parse(file, Firecrawl::Models::ParseOptions.new(formats: ["markdown"]))
    assert_equal "# Parsed", doc.markdown
  end

  # ================================================================
  # MONITOR - SEARCH TARGET
  # ================================================================

  def test_create_monitor_forwards_search_target
    captured = nil
    stub_request(:post, "#{BASE_URL}/v2/monitor")
      .with { |req| captured = JSON.parse(req.body); true }
      .to_return(
        status: 200,
        body: JSON.generate(success: true, data: { id: "mon_1", judgeEnabled: true, goal: "g" }),
        headers: { "Content-Type" => "application/json" }
      )

    search_target = {
      "type" => "search",
      "queries" => ["firecrawl launch"],
      "searchWindow" => "24h",
      "includeDomains" => ["firecrawl.dev"],
      "excludeDomains" => ["spam.com"],
      "maxResults" => 20,
    }

    monitor = @client.create_monitor(
      name: "Search monitor",
      schedule: { "text" => "every 30 minutes" },
      targets: [search_target],
      goal: "g",
      judge_enabled: true
    )

    assert_equal search_target, captured["targets"][0]
    assert_equal "search", captured["targets"][0]["type"]
    assert_equal "24h", captured["targets"][0]["searchWindow"]
    assert_equal "g", monitor.goal
    assert_equal true, monitor.judge_enabled
  end

  def test_monitor_search_target_model_to_h
    target = Firecrawl::Models::MonitorTarget.new(
      "type" => "search",
      "queries" => ["a", "b"],
      "searchWindow" => "1h",
      "includeDomains" => ["x.com"],
      "excludeDomains" => ["y.com"],
      "maxResults" => 5
    )

    assert_equal "search", target.type
    assert_equal ["a", "b"], target.queries
    assert_equal "1h", target.search_window
    assert_equal 5, target.max_results
    assert_equal(
      {
        "type" => "search",
        "queries" => ["a", "b"],
        "searchWindow" => "1h",
        "includeDomains" => ["x.com"],
        "excludeDomains" => ["y.com"],
        "maxResults" => 5,
      },
      target.to_h
    )
  end

  def test_monitor_search_target_result_model
    result = Firecrawl::Models::MonitorTargetResult.new(
      "targetId" => "tgt_1",
      "type" => "search",
      "searchCompleted" => true,
      "resultCount" => 10,
      "matches" => 3,
      "summary" => "found stuff",
      "judgeDegraded" => false,
      "degradedReason" => nil,
      "searchCredits" => 1.5,
      "judgeCredits" => 0.5,
      "resultsJudged" => 8
    )

    assert_equal "tgt_1", result.target_id
    assert_equal "search", result.type
    assert_equal true, result.search_completed
    assert_equal 10, result.result_count
    assert_equal 3, result.matches
    assert_equal "found stuff", result.summary
    assert_equal false, result.judge_degraded
    assert_nil result.degraded_reason
    assert_in_delta 1.5, result.search_credits
    assert_in_delta 0.5, result.judge_credits
    assert_equal 8, result.results_judged
  end
end
