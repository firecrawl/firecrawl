# frozen_string_literal: true

module Firecrawl
  module Models
    # Response from starting an async crawl job.
    class CrawlResponse
      attr_reader :id, :url

      def initialize(data)
        @id = data["id"]
        @url = data["url"]
      end

      def to_s
        "CrawlResponse{id=#{id}, url=#{url}}"
      end
    end
  end
end
