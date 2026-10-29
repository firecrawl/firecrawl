# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for crawling a website.
    class CrawlOptions
      FIELDS = %i[
        prompt exclude_paths include_paths max_discovery_depth sitemap
        ignore_query_parameters deduplicate_similar_urls limit
        crawl_entire_domain allow_external_links allow_subdomains
        delay max_concurrency webhook scrape_options regex_on_full_url
        zero_data_retention integration
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
      end

      def to_h
        h = {
          "prompt" => prompt,
          "excludePaths" => exclude_paths,
          "includePaths" => include_paths,
          "maxDiscoveryDepth" => max_discovery_depth,
          "sitemap" => sitemap,
          "ignoreQueryParameters" => ignore_query_parameters,
          "deduplicateSimilarURLs" => deduplicate_similar_urls,
          "limit" => limit,
          "crawlEntireDomain" => crawl_entire_domain,
          "allowExternalLinks" => allow_external_links,
          "allowSubdomains" => allow_subdomains,
          "delay" => delay,
          "maxConcurrency" => max_concurrency,
          "webhook" => serialize_webhook,
          "scrapeOptions" => scrape_options&.to_h,
          "regexOnFullURL" => regex_on_full_url,
          "zeroDataRetention" => zero_data_retention,
          "integration" => integration,
        }.compact
        h
      end

      private

      def serialize_webhook
        return webhook if webhook.is_a?(String) || webhook.is_a?(Hash)
        webhook&.to_h
      end
    end
  end
end
