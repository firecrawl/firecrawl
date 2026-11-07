# frozen_string_literal: true

module Firecrawl
  module Models
    # PDF parser configuration for use in ScrapeOptions / ParseOptions parsers.
    class PDFParser
      attr_reader :mode, :max_pages, :pages, :blocks, :page_markers

      def initialize(mode: nil, max_pages: nil, pages: nil, blocks: nil, page_markers: nil)
        @mode = mode
        @max_pages = max_pages
        @pages = pages
        @blocks = blocks
        @page_markers = page_markers
      end

      def to_h
        {
          "type" => "pdf",
          "mode" => mode,
          "maxPages" => max_pages,
          "pages" => pages,
          "blocks" => blocks,
          "pageMarkers" => page_markers,
        }.compact
      end

      def type
        "pdf"
      end
    end
  end
end
