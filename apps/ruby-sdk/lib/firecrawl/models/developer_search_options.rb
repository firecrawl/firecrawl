# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for a developer search request. Unset fields are omitted.
    #
    # - k: total ranked results, 1 to 100 (default 10)
    # - passages: passages per result, 1 to 5 (default 1)
    # - types: result kinds, any of "doc", "issue", "pull_request", "readme"
    # - repos: GitHub owner/name filters, at most 20
    # - sources: developer documentation source IDs, at most 20
    # - language: one case-insensitive GitHub Linguist primary language
    # - topic: repository topics that must all match, at most 8
    # - license: one case-insensitive SPDX repository license identifier
    # - min_stars, max_stars, archived, fork: repository filters
    # - skills: "only" returns packaged agent-skill evidence only
    class DeveloperSearchOptions
      FIELDS = %i[
        k passages types repos sources language topic license
        min_stars max_stars archived fork skills
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        unknown = kwargs.keys - FIELDS
        raise ArgumentError, "unknown developer search option(s): #{unknown.join(", ")}" unless unknown.empty?

        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
      end

      def to_h
        FIELDS.to_h { |f| [f.to_s, public_send(f)] }.compact
      end
    end
  end
end
