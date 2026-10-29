# frozen_string_literal: true

module Firecrawl
  module Models
    # Result of a map operation containing discovered URLs.
    # The v2 API may return links as either plain URL strings or objects
    # with url, title, and description fields. This class normalises both.
    class MapData
      attr_reader :links

      def initialize(data)
        raw_links = data["links"] || []
        @links = raw_links.map do |item|
          if item.is_a?(Hash)
            item
          elsif item.is_a?(String)
            { "url" => item }
          end
        end.compact
      end

      def to_s
        "MapData{links=#{links.size}}"
      end
    end
  end
end
