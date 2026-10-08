# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for scraping a single URL.
    #
    # check_prompt_injection scans the page content for prompt injection with
    # any format except rawBase64, before LLM-backed formats run. A detection
    # fails the scrape with SCRAPE_PROMPT_INJECTION_DETECTED. Adds 4 credits
    # when the check scans the whole page.
    class ScrapeOptions
      FIELDS = %i[
        formats headers include_tags exclude_tags only_main_content
        timeout wait_for mobile parsers actions location
        skip_tls_verification remove_base64_images block_ads proxy
        max_age store_in_cache lockdown check_prompt_injection redact_pii
        integration audit_metadata
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
        if audit_metadata && !audit_metadata.is_a?(AuditMetadata)
          raise ArgumentError, "audit_metadata must be an AuditMetadata"
        end
        @skip_tls_verification = false if @skip_tls_verification.nil?
      end

      def to_h
        {
          "formats" => formats&.map { |fmt| format_value(fmt) },
          "headers" => headers,
          "includeTags" => include_tags,
          "excludeTags" => exclude_tags,
          "onlyMainContent" => only_main_content,
          "timeout" => timeout,
          "waitFor" => wait_for,
          "mobile" => mobile,
          "parsers" => parsers&.map { |parser| parser.respond_to?(:to_h) ? parser.to_h : parser },
          "actions" => actions,
          "location" => location.is_a?(Hash) ? location : location&.to_h,
          "skipTlsVerification" => skip_tls_verification,
          "removeBase64Images" => remove_base64_images,
          "blockAds" => block_ads,
          "proxy" => proxy,
          "maxAge" => max_age,
          "storeInCache" => store_in_cache,
          "lockdown" => lockdown,
          "checkPromptInjection" => check_prompt_injection,
          "redactPII" => redact_pii,
          "integration" => integration,
          "auditMetadata" => audit_metadata&.to_h,
        }.compact
      end

      private

      def format_value(fmt)
        fmt.respond_to?(:to_h) ? fmt.to_h : fmt
      end
    end
  end
end
