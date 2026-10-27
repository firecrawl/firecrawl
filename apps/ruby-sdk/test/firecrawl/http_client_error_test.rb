# frozen_string_literal: true

require "minitest/autorun"
require_relative "../../lib/firecrawl/errors"
require_relative "../../lib/firecrawl/http_client"

class HttpClientErrorTest < Minitest::Test
  def client_for(body, status = 400)
    client = Firecrawl::HttpClient.new(api_key: "test", base_url: "https://api.firecrawl.dev",
      timeout: 1, max_retries: 0, backoff_factor: 0)
    response = Struct.new(:code, :body).new(status.to_s, body)
    client.define_singleton_method(:perform_request) { |_uri, _request| response }
    client
  end

  def test_non_object_json_error_bodies_preserve_http_errors
    ["[]", "null", "42", "true", '"failure"'].each do |body|
      error = assert_raises(Firecrawl::FirecrawlError) { client_for(body).get("/v2/map") }
      assert_equal 400, error.status_code
      assert_equal "HTTP 400 error", error.message
      assert_nil error.error_code
    end
  end

  def test_non_object_authentication_and_rate_limit_errors_keep_their_types
    [[401, Firecrawl::AuthenticationError], [429, Firecrawl::RateLimitError]].each do |status, type|
      error = assert_raises(type) { client_for("null", status).get("/v2/map") }
      assert_equal status, error.status_code
    end
  end

  def test_object_error_fields_are_preserved
    error = assert_raises(Firecrawl::FirecrawlError) do
      client_for('{"error":"Bad request","code":"INVALID_INPUT"}').get("/v2/map")
    end
    assert_equal "Bad request", error.message
    assert_equal "INVALID_INPUT", error.error_code
  end

  def test_non_json_error_fallback
    error = assert_raises(Firecrawl::FirecrawlError) { client_for("Bad gateway", 502).get("/v2/map") }
    assert_equal "HTTP 502 error", error.message
    assert_nil error.error_code
  end
end
