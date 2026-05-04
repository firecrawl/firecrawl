# frozen_string_literal: true

require "net/http"
require "json"
require "securerandom"
require "uri"

module Firecrawl
  # Internal HTTP client for making authenticated requests to the Firecrawl API.
  # Handles retry logic with exponential backoff.
  #
  # @api private
  class HttpClient
    def initialize(api_key:, base_url:, timeout:, max_retries:, backoff_factor:)
      @api_key = api_key
      @base_url = base_url.chomp("/")
      @timeout = timeout
      @max_retries = max_retries
      @backoff_factor = backoff_factor
    end

    # Sends a POST request with JSON body.
    def post(path, body, extra_headers: {})
      uri = URI("#{@base_url}#{path}")
      request = Net::HTTP::Post.new(uri)
      request["Authorization"] = "Bearer #{@api_key}"
      request["Content-Type"] = "application/json"
      extra_headers.each { |k, v| request[k] = v }
      request.body = JSON.generate(body)
      execute_with_retry(uri, request)
    end

    # Sends a GET request.
    def get(path)
      uri = URI("#{@base_url}#{path}")
      request = Net::HTTP::Get.new(uri)
      request["Authorization"] = "Bearer #{@api_key}"
      execute_with_retry(uri, request)
    end

    # Sends a GET request with a full URL (for following next-page cursors).
    # Only sends the Authorization header if the URL matches the configured API origin.
    def get_absolute(absolute_url)
      uri = URI(absolute_url)
      base_uri = URI(@base_url)
      unless uri.host == base_uri.host && uri.port == base_uri.port && uri.scheme == base_uri.scheme
        raise FirecrawlError, "Absolute URL origin (#{uri.scheme}://#{uri.host}:#{uri.port}) does not match API base URL origin (#{base_uri.scheme}://#{base_uri.host}:#{base_uri.port}). Refusing to send credentials."
      end
      request = Net::HTTP::Get.new(uri)
      request["Authorization"] = "Bearer #{@api_key}"
      execute_with_retry(uri, request)
    end

    # Sends a DELETE request.
    def delete(path)
      uri = URI("#{@base_url}#{path}")
      request = Net::HTTP::Delete.new(uri)
      request["Authorization"] = "Bearer #{@api_key}"
      execute_with_retry(uri, request)
    end

    # Sends a PATCH request with JSON body.
    def patch(path, body)
      uri = URI("#{@base_url}#{path}")
      request = Net::HTTP::Patch.new(uri)
      request["Authorization"] = "Bearer #{@api_key}"
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
      execute_with_retry(uri, request)
    end

    # Sends a POST request with a multipart/form-data body.
    #
    # @param path [String] API path
    # @param fields [Hash{String=>String}] additional form fields to include
    # @param file_field [String] form field name for the file part (e.g. "file")
    # @param filename [String] filename to send with the file part
    # @param content [String] raw bytes for the file part
    # @param content_type [String, nil] optional MIME type for the file part
    def post_multipart(path, fields:, file_field:, filename:, content:, content_type: nil)
      uri = URI("#{@base_url}#{path}")
      boundary = "----FirecrawlBoundary#{SecureRandom.hex(16)}"
      body = build_multipart_body(boundary, fields, file_field, filename, content, content_type)

      builder = lambda do
        request = Net::HTTP::Post.new(uri)
        request["Authorization"] = "Bearer #{@api_key}"
        request["Content-Type"] = "multipart/form-data; boundary=#{boundary}"
        request.body = body
        request
      end

      execute_with_retry(uri, builder.call, request_builder: builder)
    end

    private

    def build_multipart_body(boundary, fields, file_field, filename, content, content_type)
      parts = +""
      fields.each do |name, value|
        parts << "--#{boundary}\r\n"
        parts << %(Content-Disposition: form-data; name="#{name}"\r\n\r\n)
        parts << value.to_s
        parts << "\r\n"
      end

      parts << "--#{boundary}\r\n"
      safe_file_field = file_field.to_s.gsub(/[\r\n"]/, "_")
      safe_filename = filename.to_s.gsub(/[\r\n"]/, "_")
      parts << %(Content-Disposition: form-data; name="#{safe_file_field}"; filename="#{safe_filename}"\r\n)
      parts << "Content-Type: #{content_type || "application/octet-stream"}\r\n\r\n"
      parts.force_encoding(Encoding::ASCII_8BIT)
      parts << content.to_s.dup.force_encoding(Encoding::ASCII_8BIT)
      parts << "\r\n--#{boundary}--\r\n"
      parts
    end

    def execute_with_retry(uri, request, request_builder: nil)
      attempt = 0
      loop do
        response = perform_request(uri, request)
        code = response.code.to_i
        body_str = response.body || ""

        if code >= 200 && code < 300
          return body_str.empty? ? {} : JSON.parse(body_str)
        end

        error_message = extract_error_message(body_str, code)
        error_code = extract_error_code(body_str)

        # Non-retryable client errors
        if code == 401
          raise AuthenticationError.new(error_message, error_code: error_code)
        end
        if code == 429
          raise RateLimitError.new(error_message, error_code: error_code)
        end
        if code >= 400 && code < 500 && code != 408 && code != 409
          raise FirecrawlError.new(error_message, status_code: code, error_code: error_code)
        end

        # Retryable errors: 408, 409, 502, 5xx
        if attempt < @max_retries
          attempt += 1
          sleep_with_backoff(attempt)
          request = request_builder.call if request_builder
          next
        end

        raise FirecrawlError.new(error_message, status_code: code, error_code: error_code)
      rescue Errno::ECONNREFUSED, Errno::ECONNRESET, Errno::ETIMEDOUT,
             Net::OpenTimeout, Net::ReadTimeout, IOError => e
        if attempt < @max_retries
          attempt += 1
          sleep_with_backoff(attempt)
          request = request_builder.call if request_builder
          retry
        end
        raise FirecrawlError.new("Request failed: #{e.message}")
      end
    end

    def perform_request(uri, request)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = (uri.scheme == "https")
      http.open_timeout = @timeout
      http.read_timeout = @timeout
      http.write_timeout = @timeout
      http.request(request)
    end

    def extract_error_message(body, status_code)
      parsed = JSON.parse(body)
      parsed["error"] || parsed["message"] || "HTTP #{status_code} error"
    rescue JSON::ParserError
      "HTTP #{status_code} error"
    end

    def extract_error_code(body)
      parsed = JSON.parse(body)
      code = parsed["code"]
      code&.to_s
    rescue JSON::ParserError
      nil
    end

    def sleep_with_backoff(attempt)
      delay = @backoff_factor * (2**(attempt - 1))
      sleep(delay)
    end
  end
end
