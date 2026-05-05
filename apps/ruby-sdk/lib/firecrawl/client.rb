# frozen_string_literal: true

require "json"
require "uri"

module Firecrawl
  # Client for the Firecrawl v2 API.
  #
  # @example Quick start
  #   client = Firecrawl::Client.new(api_key: "fc-your-api-key")
  #
  #   # Scrape a single page
  #   doc = client.scrape("https://example.com",
  #     Firecrawl::Models::ScrapeOptions.new(formats: ["markdown"]))
  #
  #   # Crawl a website
  #   job = client.crawl("https://example.com",
  #     Firecrawl::Models::CrawlOptions.new(limit: 50))
  class Client
    DEFAULT_API_URL = "https://api.firecrawl.dev"
    DEFAULT_TIMEOUT = 300 # seconds
    DEFAULT_MAX_RETRIES = 3
    DEFAULT_BACKOFF_FACTOR = 0.5
    DEFAULT_POLL_INTERVAL = 2 # seconds
    DEFAULT_JOB_TIMEOUT = 300 # seconds

    # Creates a new Firecrawl client.
    #
    # @param api_key [String, nil] API key (falls back to FIRECRAWL_API_KEY env var)
    # @param api_url [String] API base URL
    # @param timeout [Integer] HTTP request timeout in seconds
    # @param max_retries [Integer] maximum automatic retries for transient failures
    # @param backoff_factor [Float] exponential backoff factor in seconds
    def initialize(
      api_key: nil,
      api_url: nil,
      timeout: DEFAULT_TIMEOUT,
      max_retries: DEFAULT_MAX_RETRIES,
      backoff_factor: DEFAULT_BACKOFF_FACTOR
    )
      resolved_key = api_key || ENV["FIRECRAWL_API_KEY"]
      if resolved_key.nil? || resolved_key.strip.empty?
        raise FirecrawlError, "API key is required. Provide api_key: or set FIRECRAWL_API_KEY environment variable."
      end

      resolved_url = api_url || ENV["FIRECRAWL_API_URL"] || DEFAULT_API_URL
      unless resolved_url.match?(%r{\Ahttps?://}i)
        raise FirecrawlError, "API URL must be a fully qualified HTTP or HTTPS URL (got: #{resolved_url})."
      end

      @http = HttpClient.new(
        api_key: resolved_key,
        base_url: resolved_url,
        timeout: timeout,
        max_retries: max_retries,
        backoff_factor: backoff_factor
      )
    end

    # Creates a client from the FIRECRAWL_API_KEY environment variable.
    #
    # @return [Client]
    def self.from_env
      new
    end

    # ================================================================
    # SCRAPE
    # ================================================================

    # Scrapes a single URL and returns the document.
    #
    # @param url [String] the URL to scrape
    # @param options [Models::ScrapeOptions, nil] scrape configuration
    # @return [Models::Document]
    def scrape(url, options = nil)
      raise ArgumentError, "URL is required" if url.nil?

      body = { "url" => url }
      body.merge!(options.to_h) if options
      raw = @http.post("/v2/scrape", body)
      data = raw["data"] || raw
      Models::Document.new(data)
    end

    # Interacts with the scrape-bound browser session for a scrape job.
    #
    # @param job_id [String] the scrape job ID
    # @param code [String] the code to execute
    # @param language [String] "python", "node", or "bash" (default: "node")
    # @param timeout [Integer, nil] execution timeout in seconds (1-300)
    # @return [Hash] execution result with stdout, stderr, exit_code
    def interact(job_id, code, language: "node", timeout: nil)
      raise ArgumentError, "Job ID is required" if job_id.nil?
      raise ArgumentError, "Code is required" if code.nil?

      body = { "code" => code, "language" => language }
      body["timeout"] = timeout if timeout
      @http.post("/v2/scrape/#{job_id}/interact", body)
    end

    # Stops the interactive browser session for a scrape job.
    #
    # @param job_id [String] the scrape job ID
    # @return [Hash] stop response
    def stop_interactive_browser(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      @http.delete("/v2/scrape/#{job_id}/interact")
    end

    # ================================================================
    # PARSE
    # ================================================================

    # Parses an uploaded file and returns the extracted document.
    #
    # @param file [Models::ParseFile] file payload to upload
    # @param options [Models::ParseOptions, nil] parse configuration
    # @return [Models::Document]
    def parse(file, options = nil)
      raise ArgumentError, "File is required" if file.nil?
      unless file.is_a?(Models::ParseFile)
        raise ArgumentError, "File must be a Firecrawl::Models::ParseFile"
      end

      options_hash = options.nil? ? {} : options.to_h
      raw = @http.post_multipart(
        "/v2/parse",
        fields: { "options" => JSON.generate(options_hash) },
        file_field: "file",
        filename: file.filename,
        content: file.content,
        content_type: file.content_type,
      )
      data = raw["data"] || raw
      Models::Document.new(data)
    end

    # ================================================================
    # CRAWL
    # ================================================================

    # Starts an async crawl job and returns immediately.
    #
    # @param url [String] the URL to start crawling from
    # @param options [Models::CrawlOptions, nil] crawl configuration
    # @return [Models::CrawlResponse]
    def start_crawl(url, options = nil)
      raise ArgumentError, "URL is required" if url.nil?

      body = { "url" => url }
      body.merge!(options.to_h) if options
      raw = @http.post("/v2/crawl", body)
      Models::CrawlResponse.new(raw)
    end

    # Gets the status and results of a crawl job.
    #
    # @param job_id [String] the crawl job ID
    # @return [Models::CrawlJob]
    def get_crawl_status(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      raw = @http.get("/v2/crawl/#{job_id}")
      Models::CrawlJob.new(raw)
    end

    # Crawls a website and waits for completion (auto-polling).
    #
    # @param url [String] the URL to crawl
    # @param options [Models::CrawlOptions, nil] crawl configuration
    # @param poll_interval [Integer] seconds between status checks
    # @param timeout [Integer] maximum seconds to wait
    # @return [Models::CrawlJob]
    def crawl(url, options = nil, poll_interval: DEFAULT_POLL_INTERVAL, timeout: DEFAULT_JOB_TIMEOUT)
      start = start_crawl(url, options)
      poll_crawl(start.id, poll_interval, timeout)
    end

    # Cancels a running crawl job.
    #
    # @param job_id [String] the crawl job ID
    # @return [Hash]
    def cancel_crawl(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      @http.delete("/v2/crawl/#{job_id}")
    end

    # Gets errors from a crawl job.
    #
    # @param job_id [String] the crawl job ID
    # @return [Hash]
    def get_crawl_errors(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      @http.get("/v2/crawl/#{job_id}/errors")
    end

    # ================================================================
    # BATCH SCRAPE
    # ================================================================

    # Starts an async batch scrape job.
    #
    # @param urls [Array<String>] the URLs to scrape
    # @param options [Models::BatchScrapeOptions, nil] batch scrape configuration
    # @return [Models::BatchScrapeResponse]
    def start_batch_scrape(urls, options = nil)
      raise ArgumentError, "URLs list is required" if urls.nil?

      body = { "urls" => urls }
      extra_headers = {}
      if options
        opts_hash = options.to_h

        # idempotencyKey goes as a header, not in body
        if options.idempotency_key && !options.idempotency_key.empty?
          extra_headers["x-idempotency-key"] = options.idempotency_key
        end

        # Flatten nested scrape options to top level (API expects this)
        nested = opts_hash.delete("options")
        body.merge!(opts_hash)
        body.merge!(nested) if nested
      end
      raw = @http.post("/v2/batch/scrape", body, extra_headers: extra_headers)
      Models::BatchScrapeResponse.new(raw)
    end

    # Gets the status and results of a batch scrape job.
    #
    # @param job_id [String] the batch scrape job ID
    # @return [Models::BatchScrapeJob]
    def get_batch_scrape_status(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      raw = @http.get("/v2/batch/scrape/#{job_id}")
      Models::BatchScrapeJob.new(raw)
    end

    # Batch-scrapes URLs and waits for completion (auto-polling).
    #
    # @param urls [Array<String>] the URLs to scrape
    # @param options [Models::BatchScrapeOptions, nil] batch scrape configuration
    # @param poll_interval [Integer] seconds between status checks
    # @param timeout [Integer] maximum seconds to wait
    # @return [Models::BatchScrapeJob]
    def batch_scrape(urls, options = nil, poll_interval: DEFAULT_POLL_INTERVAL, timeout: DEFAULT_JOB_TIMEOUT)
      start = start_batch_scrape(urls, options)
      poll_batch_scrape(start.id, poll_interval, timeout)
    end

    # Cancels a running batch scrape job.
    #
    # @param job_id [String] the batch scrape job ID
    # @return [Hash]
    def cancel_batch_scrape(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      @http.delete("/v2/batch/scrape/#{job_id}")
    end

    # ================================================================
    # MAP
    # ================================================================

    # Discovers URLs on a website.
    #
    # @param url [String] the URL to map
    # @param options [Models::MapOptions, nil] map configuration
    # @return [Models::MapData]
    def map(url, options = nil)
      raise ArgumentError, "URL is required" if url.nil?

      body = { "url" => url }
      body.merge!(options.to_h) if options
      raw = @http.post("/v2/map", body)
      data = raw["data"] || raw
      Models::MapData.new(data)
    end

    # ================================================================
    # MONITOR
    # ================================================================

    def create_monitor(name:, schedule:, targets:, webhook: nil, notification: nil, retention_days: nil)
      body = {
        "name" => name,
        "schedule" => schedule,
        "targets" => targets,
        "webhook" => webhook,
        "notification" => notification,
        "retentionDays" => retention_days,
      }.compact
      raw = @http.post("/v2/monitor", body)
      Models::Monitor.new(raw["data"] || raw)
    end

    def list_monitors(limit: nil, offset: nil)
      raw = @http.get("/v2/monitor#{query(limit: limit, offset: offset)}")
      (raw["data"] || []).map { |item| Models::Monitor.new(item) }
    end

    def get_monitor(monitor_id)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?

      raw = @http.get("/v2/monitor/#{monitor_id}")
      Models::Monitor.new(raw["data"] || raw)
    end

    def update_monitor(monitor_id, **attrs)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?

      body = {
        "name" => attrs[:name],
        "status" => attrs[:status],
        "schedule" => attrs[:schedule],
        "webhook" => attrs[:webhook],
        "notification" => attrs[:notification],
        "targets" => attrs[:targets],
        "retentionDays" => attrs[:retention_days],
      }.compact
      raw = @http.patch("/v2/monitor/#{monitor_id}", body)
      Models::Monitor.new(raw["data"] || raw)
    end

    def delete_monitor(monitor_id)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?

      @http.delete("/v2/monitor/#{monitor_id}")["success"] == true
    end

    def run_monitor(monitor_id)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?

      raw = @http.post("/v2/monitor/#{monitor_id}/run", {})
      Models::MonitorCheck.new(raw["data"] || raw)
    end

    def list_monitor_checks(monitor_id, limit: nil, offset: nil)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?

      raw = @http.get("/v2/monitor/#{monitor_id}/checks#{query(limit: limit, offset: offset)}")
      (raw["data"] || []).map { |item| Models::MonitorCheck.new(item) }
    end

    def get_monitor_check(monitor_id, check_id, limit: nil, skip: nil, status: nil, auto_paginate: true)
      raise ArgumentError, "Monitor ID is required" if monitor_id.nil?
      raise ArgumentError, "Check ID is required" if check_id.nil?

      params = query(limit: limit, skip: skip, status: status)
      raw = @http.get("/v2/monitor/#{monitor_id}/checks/#{check_id}#{params}")
      data = raw["data"] || raw
      data["next"] = raw["next"] if raw["next"]
      check = Models::MonitorCheckDetail.new(data)
      auto_paginate ? paginate_monitor_check(check) : check
    end

    # ================================================================
    # SEARCH
    # ================================================================

    # Performs a web search.
    #
    # @param query [String] the search query
    # @param options [Models::SearchOptions, nil] search configuration
    # @return [Models::SearchData]
    def search(query, options = nil)
      raise ArgumentError, "Query is required" if query.nil?

      body = { "query" => query }
      body.merge!(options.to_h) if options
      raw = @http.post("/v2/search", body)
      data = raw["data"] || raw
      Models::SearchData.new(data)
    end

    # ================================================================
    # AGENT
    # ================================================================

    # Starts an async agent task.
    #
    # @param options [Models::AgentOptions] agent configuration
    # @return [Models::AgentResponse]
    def start_agent(options)
      raise ArgumentError, "Agent options are required" if options.nil?

      raw = @http.post("/v2/agent", options.to_h)
      Models::AgentResponse.new(raw)
    end

    # Gets the status of an agent task.
    #
    # @param job_id [String] the agent job ID
    # @return [Models::AgentStatusResponse]
    def get_agent_status(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      raw = @http.get("/v2/agent/#{job_id}")
      Models::AgentStatusResponse.new(raw)
    end

    # Runs an agent task and waits for completion (auto-polling).
    #
    # @param options [Models::AgentOptions] agent configuration
    # @param poll_interval [Integer] seconds between status checks
    # @param timeout [Integer] maximum seconds to wait
    # @return [Models::AgentStatusResponse]
    def agent(options, poll_interval: DEFAULT_POLL_INTERVAL, timeout: DEFAULT_JOB_TIMEOUT)
      start = start_agent(options)
      raise FirecrawlError, "Agent start did not return a job ID" if start.id.nil?

      deadline = Time.now + timeout
      while Time.now < deadline
        status = get_agent_status(start.id)
        return status if status.done?

        sleep(poll_interval)
      end
      raise JobTimeoutError.new(start.id, timeout, "Agent")
    end

    # Cancels a running agent task.
    #
    # @param job_id [String] the agent job ID
    # @return [Hash]
    def cancel_agent(job_id)
      raise ArgumentError, "Job ID is required" if job_id.nil?

      @http.delete("/v2/agent/#{job_id}")
    end

    # ================================================================
    # USAGE & METRICS
    # ================================================================

    # Gets current concurrency usage.
    #
    # @return [Models::ConcurrencyCheck]
    def get_concurrency
      raw = @http.get("/v2/concurrency-check")
      Models::ConcurrencyCheck.new(raw)
    end

    # Gets current credit usage.
    #
    # @return [Models::CreditUsage]
    def get_credit_usage
      raw = @http.get("/v2/team/credit-usage")
      data = raw["data"] || raw
      Models::CreditUsage.new(data)
    end

    private

    def query(**params)
      compact = params.compact
      compact.empty? ? "" : "?#{URI.encode_www_form(compact)}"
    end

    def poll_crawl(job_id, poll_interval, timeout)
      deadline = Time.now + timeout
      while Time.now < deadline
        job = get_crawl_status(job_id)
        return paginate_crawl(job) if job.done?

        sleep(poll_interval)
      end
      raise JobTimeoutError.new(job_id, timeout, "Crawl")
    end

    def poll_batch_scrape(job_id, poll_interval, timeout)
      deadline = Time.now + timeout
      while Time.now < deadline
        job = get_batch_scrape_status(job_id)
        return paginate_batch_scrape(job) if job.done?

        sleep(poll_interval)
      end
      raise JobTimeoutError.new(job_id, timeout, "Batch scrape")
    end

    def paginate_crawl(job)
      job.data ||= []
      current = job
      while current.next_url && !current.next_url.empty?
        raw = @http.get_absolute(current.next_url)
        next_page = Models::CrawlJob.new(raw)
        job.data.concat(next_page.data) unless next_page.data.empty?
        current = next_page
      end
      job
    end

    def paginate_batch_scrape(job)
      job.data ||= []
      current = job
      while current.next_url && !current.next_url.empty?
        raw = @http.get_absolute(current.next_url)
        next_page = Models::BatchScrapeJob.new(raw)
        job.data.concat(next_page.data) unless next_page.data.empty?
        current = next_page
      end
      job
    end

    def paginate_monitor_check(check)
      check.pages ||= []
      current = check
      while current.next_url && !current.next_url.empty?
        raw = @http.get_absolute(current.next_url)
        data = raw["data"] || raw
        data["next"] = raw["next"] if raw["next"]
        next_page = Models::MonitorCheckDetail.new(data)
        check.pages.concat(next_page.pages) unless next_page.pages.empty?
        current = next_page
      end
      check.next_url = nil
      check
    end
  end
end
