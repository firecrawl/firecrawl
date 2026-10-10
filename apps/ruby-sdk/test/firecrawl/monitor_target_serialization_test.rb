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

    @requests.each do |request|
      assert_equal [model.to_h, plain], request["targets"]
    end
  end

  def test_hash_targets_keep_unknown_fields
    target = { "type" => "scrape", "urls" => ["https://example.com"], "futureField" => false }
    @client.create_monitor(name: "test", schedule: "0 0 * * *", targets: [target])
    @client.update_monitor("monitor", targets: [target])
    @requests.each { |request| assert_equal [target], request["targets"] }
  end

  def test_update_without_targets_does_not_send_targets
    @client.update_monitor("monitor", name: "renamed")
    refute @requests.first.key?("targets")
  end
end
