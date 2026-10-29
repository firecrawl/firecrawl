# frozen_string_literal: true

module Firecrawl
  module Models
    # Response from starting an async batch scrape job.
    class BatchScrapeResponse
      attr_reader :id, :url, :invalid_urls

      def initialize(data)
        @id = data["id"]
        @url = data["url"]
        @invalid_urls = data["invalidURLs"]
      end

      def to_s
        "BatchScrapeResponse{id=#{id}, url=#{url}}"
      end
    end
  end
end
