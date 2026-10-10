# frozen_string_literal: true

require_relative "../test_helper"
require "socket"
require "timeout"

class SearchToolsNativeTest < Minitest::Test
  def setup
    WebMock.disable_net_connect!(allow_localhost: true)
  end

  def teardown
    WebMock.disable_net_connect!
  end

  def with_response(data)
    server = TCPServer.new("127.0.0.1", 0)
    captured = Queue.new
    worker = Thread.new do
      socket = server.accept
      begin
        line = socket.gets
        headers = {}
        while (header = socket.gets) && header != "\r\n"
          key, value = header.split(":", 2)
          headers[key.downcase] = value.strip
        end
        body = socket.read(headers.fetch("content-length").to_i)
        captured << [line, JSON.parse(body)]
        response = JSON.generate({ "success" => true, "data" => data })
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: #{response.bytesize}\r\nConnection: close\r\n\r\n#{response}")
      ensure
        socket.close
      end
    end
    client = Firecrawl::Client.new(api_key: "owned-fixture", api_url: "http://127.0.0.1:#{server.addr[1]}", timeout: 2, max_retries: 0)
    yield client, captured
  ensure
    server&.close
    worker&.join(3)
    worker&.kill if worker&.alive?
  end

  def test_typed_tool_options_reach_search_http_request
    with_response({ "web" => [] }) do |client, captured|
      options = Firecrawl::Models::SearchOptions.new(sources: ["alexandria"], domain_tools: true, tool_detail: "full")
      client.search("owned query", options)
      line, body = Timeout.timeout(3) { captured.pop }
      assert_equal "POST /v2/search HTTP/1.1\r\n", line
      assert_equal true, body["domainTools"]
      assert_equal "full", body["toolDetail"]
      assert_equal ["alexandria"], body["sources"]
    end
  end

  def test_returned_tools_are_accessible_without_losing_web_results
    tools = [{ "domain" => "example.test", "tools" => [{ "name" => "owned", "schema" => { "type" => "object" } }] }]
    web = [{ "url" => "https://example.test" }]
    with_response({ "web" => web, "tools" => tools }) do |client, _|
      result = client.search("owned query")
      assert_equal tools, result.tools
      assert_equal web, result.web
    end
  end

  def test_false_option_and_existing_results_remain_intact
    data = { "web" => [], "news" => [{ "title" => "owned" }], "images" => [] }
    with_response(data) do |client, captured|
      result = client.search("owned query", Firecrawl::Models::SearchOptions.new(domain_tools: false))
      _, body = Timeout.timeout(3) { captured.pop }
      assert_equal false, body["domainTools"]
      assert_equal data["news"], result.news
      assert_equal [], result.images
    end
  end

  def test_ordinary_search_response_retains_all_existing_collections
    data = { "web" => [{ "url" => "https://example.test" }], "news" => [{ "title" => "owned" }], "images" => [{ "url" => "https://example.test/image" }] }
    with_response(data) do |client, _|
      result = client.search("owned query")
      assert_equal data["web"], result.web
      assert_equal data["news"], result.news
      assert_equal data["images"], result.images
    end
  end

  def test_unset_options_are_omitted_and_existing_summary_remains_stable
    options = Firecrawl::Models::SearchOptions.new(limit: 2)
    assert_equal({ "limit" => 2 }, options.to_h)
    result = Firecrawl::Models::SearchData.new({ "web" => [], "news" => [], "images" => [] })
    assert_equal "SearchData{web=0, news=0, images=0}", result.to_s
  end
end
