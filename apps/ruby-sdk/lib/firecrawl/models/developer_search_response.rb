# frozen_string_literal: true

module Firecrawl
  module Models
    # One matched passage of a developer search result.
    class DeveloperSearchPassage
      attr_reader :text, :citation_url

      def initialize(data)
        @text = data["text"]
        @citation_url = data["citation_url"]
      end
    end

    # One ranked developer search result. `license` is either an SPDX string or
    # a disclosure object (Hash), so it is kept as returned.
    class DeveloperSearchResult
      attr_reader :id, :url, :title, :passages, :license

      def initialize(data)
        @id = data["id"]
        @url = data["url"]
        @title = data["title"]
        @passages = (data["passages"] || []).map { |p| DeveloperSearchPassage.new(p) }
        @license = data["license"]
      end
    end

    # Whether a requested repository is indexed, and which result types it has.
    class DeveloperSearchRepoStatus
      attr_reader :repo, :indexed, :types

      def initialize(data)
        @repo = data["repo"]
        @indexed = data["indexed"] == true
        @types = data["types"] || {}
      end

      def indexed?
        indexed
      end
    end

    # Whether a requested documentation source is indexed.
    class DeveloperSearchSourceStatus
      attr_reader :source, :indexed

      def initialize(data)
        @source = data["source"]
        @indexed = data["indexed"] == true
      end

      def indexed?
        indexed
      end
    end

    # Response from a developer search. `repos` and `sources` are present only
    # when those filters were requested.
    class DeveloperSearchResponse
      attr_reader :success, :partial, :results, :repos, :sources

      def initialize(data)
        @success = data["success"] == true
        @partial = data["partial"] == true
        @results = (data["results"] || []).map { |r| DeveloperSearchResult.new(r) }
        @repos = data["repos"]&.map { |r| DeveloperSearchRepoStatus.new(r) }
        @sources = data["sources"]&.map { |s| DeveloperSearchSourceStatus.new(s) }
      end

      def to_s
        "DeveloperSearchResponse{results=#{results.size}}"
      end
    end
  end
end
