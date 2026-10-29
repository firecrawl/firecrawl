# frozen_string_literal: true

module Firecrawl
  module Models
    # Status and results of a crawl job.
    class CrawlJob
      attr_reader :id, :status, :total, :completed, :credits_used,
                  :expires_at, :next_url
      attr_accessor :data

      def initialize(raw)
        @id = raw["id"]
        @status = raw["status"]
        @total = raw["total"].to_i
        @completed = raw["completed"].to_i
        @credits_used = raw["creditsUsed"]
        @expires_at = raw["expiresAt"]
        @next_url = raw["next"]
        @data = (raw["data"] || []).map { |d| Document.new(d) }
      end

      def done?
        %w[completed failed cancelled].include?(status)
      end

      def to_s
        "CrawlJob{id=#{id}, status=#{status}, completed=#{completed}/#{total}}"
      end
    end
  end
end
