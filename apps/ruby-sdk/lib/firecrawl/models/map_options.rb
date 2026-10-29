# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for mapping (discovering URLs on) a website.
    class MapOptions
      FIELDS = %i[
        search sitemap include_subdomains ignore_query_parameters
        limit timeout integration location audit_metadata
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
        if audit_metadata && !audit_metadata.is_a?(AuditMetadata)
          raise ArgumentError, "audit_metadata must be an AuditMetadata"
        end
      end

      def to_h
        {
          "search" => search,
          "sitemap" => sitemap,
          "includeSubdomains" => include_subdomains,
          "ignoreQueryParameters" => ignore_query_parameters,
          "limit" => limit,
          "timeout" => timeout,
          "integration" => integration,
          "location" => location.is_a?(Hash) ? location : location&.to_h,
          "auditMetadata" => audit_metadata&.to_h,
        }.compact
      end
    end
  end
end
