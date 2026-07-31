# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for a web search request.
    class SearchOptions
      FIELDS = %i[
        sources categories include_domains exclude_domains limit tbs location
        ignore_invalid_urls timeout highlights scrape_options integration enterprise
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
      end

      def to_h
        {
          "sources" => sources,
          "categories" => categories,
          "includeDomains" => include_domains,
          "excludeDomains" => exclude_domains,
          "limit" => limit,
          "tbs" => tbs,
          "location" => location,
          "ignoreInvalidURLs" => ignore_invalid_urls,
          "timeout" => timeout,
          "highlights" => highlights,
          "scrapeOptions" => scrape_options&.to_h,
          "integration" => integration,
          # Enterprise search options. Use ["zdr"] for end-to-end Zero Data
          # Retention or ["anon"] for anonymized search. Must be enabled for your team.
          "enterprise" => enterprise,
        }.compact
      end
    end
  end
end
