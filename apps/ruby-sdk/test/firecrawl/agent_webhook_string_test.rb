# frozen_string_literal: true

require_relative "../test_helper"
require "socket"
require "timeout"

class AgentWebhookStringTest < Minitest::Test
  def setup
    WebMock.disable_net_connect!(allow_localhost: true)
  end

  def teardown
    WebMock.disable_net_connect!
  end

  def with_response
    server = TCPServer.new("127.0.0.1", 0)
    captured = Queue.new
    worker = Thread.new do
      socket = nil
      begin
        socket = server.accept
        line = socket.gets
        headers = {}
        while (header = socket.gets) && header != "\r\n"
          key, value = header.split(":", 2)
          headers[key.downcase] = value.strip
        end
        body = socket.read(headers.fetch("content-length").to_i)
        captured << [line, JSON.parse(body)]
        response = JSON.generate({ "success" => true, "id" => "agent" })
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: #{response.bytesize}\r\nConnection: close\r\n\r\n#{response}")
      rescue IOError, Errno::EBADF
        raise unless server.closed?
      ensure
        socket&.close
      end
    end
    client = Firecrawl::Client.new(api_key: "owned-fixture", api_url: "http://127.0.0.1:#{server.addr[1]}", timeout: 2, max_retries: 0)
    yield client, captured
  ensure
    server&.close
    worker&.join(3)
    worker&.kill if worker&.alive?
  end

  def test_url_string_webhook_reaches_native_agent_transport
    with_response do |client, captured|
      webhook = "https://callback.example.test/events"
      result = client.start_agent(Firecrawl::Models::AgentOptions.new(prompt: "Find a page", webhook: webhook))
      line, body = Timeout.timeout(3) { captured.pop }
      assert_equal "POST /v2/agent HTTP/1.1\r\n", line
      assert_equal "agent", result.id
      assert_equal webhook, body["webhook"]
    end
  end

  def test_hash_webhook_preserves_metadata_and_events
    with_response do |client, captured|
      webhook = { "url" => "https://callback.example.test/events", "metadata" => { "job" => "123" }, "events" => ["completed"] }
      client.start_agent(Firecrawl::Models::AgentOptions.new(prompt: "Find a page", webhook: webhook))
      _, body = Timeout.timeout(3) { captured.pop }
      assert_equal webhook, body["webhook"]
    end
  end

  def test_absent_webhook_is_omitted
    with_response do |client, captured|
      client.start_agent(Firecrawl::Models::AgentOptions.new(prompt: "Find a page"))
      _, body = Timeout.timeout(3) { captured.pop }
      refute body.key?("webhook")
    end
  end
end
