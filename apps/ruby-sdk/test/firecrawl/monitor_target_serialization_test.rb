# frozen_string_literal: true

require "minitest/autorun"
require_relative "../../lib/firecrawl"

class MonitorTargetSerializationTest < Minitest::Test
  def setup
    @client = Firecrawl::Client.new(api_key: "test", max_retries: 0)
    @requests = []
    requests = @requests
    @client.instance_variable_get(:@http).define_singleton_method(:perform_request) do |_uri, request|
      requests << JSON.parse(request.body)
      Struct.new(:code, :body).new("200", '{"data":{"id":"monitor"}}')
    end
  end

  def test_create_and_update_serialize_model_targets_as_objects
    model = Firecrawl::Models::MonitorTarget.new(
      "type" => "search", "queries" => ["test"], "maxResults" => 2
    )
    plain = { "type" => "scrape", "urls" => ["https://example.com"] }
    @client.create_monitor(name: "test", schedule: "0 0 * * *", targets: [model, plain])
    @client.update_monitor("monitor", targets: [model, plain])

    assert_equal 2, @requests.length
    @requests.each do |request|
      assert_equal [model.to_h, plain], request["targets"]
    end
  end

  def test_hash_targets_keep_unknown_fields
    target = { "type" => "scrape", "urls" => ["https://example.com"], "futureField" => false }
    @client.create_monitor(name: "test", schedule: "0 0 * * *", targets: [target])
    @client.update_monitor("monitor", targets: [target])
    assert_equal 2, @requests.length
    @requests.each { |request| assert_equal [target], request["targets"] }
  end

  def test_update_without_targets_does_not_send_targets
    @client.update_monitor("monitor", name: "renamed")
    refute @requests.first.key?("targets")
  end
  def test_nested_option_models_are_serialized_as_objects_for_both_methods
    scrape = Firecrawl::Models::ScrapeOptions.new(only_main_content: false, wait_for: 123)
    crawl = Firecrawl::Models::CrawlOptions.new(limit: 4, scrape_options: scrape)
    targets = [
      Firecrawl::Models::MonitorTarget.new("type" => "scrape", "urls" => ["https://example.com"], "scrapeOptions" => scrape),
      Firecrawl::Models::MonitorTarget.new("type" => "crawl", "url" => "https://example.com", "crawlOptions" => crawl)
    ]
    @client.create_monitor(name: "test", schedule: "0 0 * * *", targets: targets)
    @client.update_monitor("monitor", targets: targets)
    assert_equal 2, @requests.length
    @requests.each do |request|
      assert_equal scrape.to_h, request["targets"][0]["scrapeOptions"]
      assert_equal crawl.to_h, request["targets"][1]["crawlOptions"]
    end
    assert_same scrape, targets[0].scrape_options
    assert_same crawl, targets[1].crawl_options
  end

  def test_non_array_targets_fail_before_request_serialization
    [ { "type" => "scrape", "urls" => ["https://example.com"] }, "not-an-array" ].each do |target|
      assert_raises(ArgumentError) do
        @client.create_monitor(name: "test", schedule: "0 0 * * *", targets: target)
      end
      assert_raises(ArgumentError) { @client.update_monitor("monitor", targets: target) }
    end
    assert_empty @requests
  end

end
