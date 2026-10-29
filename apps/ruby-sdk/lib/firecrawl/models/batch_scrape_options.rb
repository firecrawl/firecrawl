# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for a batch scrape job.
    class BatchScrapeOptions
      FIELDS = %i[
        options webhook append_to_id ignore_invalid_urls
        max_concurrency zero_data_retention idempotency_key integration
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
      end

      def to_h
        {
          "options" => options&.to_h,
          "webhook" => webhook.is_a?(String) ? webhook : webhook&.to_h,
          "appendToId" => append_to_id,
          "ignoreInvalidURLs" => ignore_invalid_urls,
          "maxConcurrency" => max_concurrency,
          "zeroDataRetention" => zero_data_retention,
          "integration" => integration,
        }.compact
      end
    end
  end
end
