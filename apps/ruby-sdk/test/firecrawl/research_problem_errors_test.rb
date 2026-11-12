# frozen_string_literal: true
require "minitest/autorun"
require "socket"
require_relative "../../lib/firecrawl"

class ResearchProblemErrorsTest < Minitest::Test
  def with_error_response(body)
    server = TCPServer.new("127.0.0.1", 0)
    path = nil
    thread = Thread.new do
      socket = server.accept
      path = socket.gets
      while (line = socket.gets) && line != "\r\n"
      end
      payload = JSON.generate(body)
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Type: application/problem+json\r\nContent-Length: #{payload.bytesize}\r\nConnection: close\r\n\r\n#{payload}")
      socket.close
    end
    client = Firecrawl::Client.new(api_key: "owned", api_url: "http://127.0.0.1:#{server.addr[1]}", max_retries: 0)
    yield client
    thread.join
    assert_match(%r{GET /v2/search/research/papers\?}, path)
  ensure
    server.close if server
    thread.kill if thread && thread.alive?
  end

  def test_problem_detail_and_type_survive_research_failure
    with_error_response("type" => "https://owned.invalid/problems/query", "title" => "Invalid query", "detail" => "Provide a narrower query") do |client|
      error = assert_raises(Firecrawl::FirecrawlError) { client.search_papers("owned query") }
      assert_equal "Provide a narrower query", error.message
      assert_equal "https://owned.invalid/problems/query", error.error_code
      assert_equal 400, error.status_code
    end
  end

  def test_problem_title_is_used_when_detail_is_absent
    with_error_response("type" => "https://owned.invalid/problems/query", "title" => "Invalid query") do |client|
      error = assert_raises(Firecrawl::FirecrawlError) { client.search_papers("owned query") }
      assert_equal "Invalid query", error.message
      assert_equal "https://owned.invalid/problems/query", error.error_code
    end
  end

  def test_standard_error_and_code_keep_precedence
    with_error_response("error" => "Original error", "code" => "ORIGINAL", "detail" => "Do not replace", "type" => "ignored") do |client|
      error = assert_raises(Firecrawl::FirecrawlError) { client.search_papers("owned query") }
      assert_equal "Original error", error.message
      assert_equal "ORIGINAL", error.error_code
    end
  end
end
