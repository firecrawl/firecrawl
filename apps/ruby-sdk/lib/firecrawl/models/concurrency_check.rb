# frozen_string_literal: true

module Firecrawl
  module Models
    # Current concurrency usage.
    class ConcurrencyCheck
      attr_reader :concurrency, :max_concurrency

      def initialize(data)
        @concurrency = data["concurrency"]
        @max_concurrency = data["maxConcurrency"]
      end

      def to_s
        "ConcurrencyCheck{concurrency=#{concurrency}/#{max_concurrency}}"
      end
    end
  end
end
