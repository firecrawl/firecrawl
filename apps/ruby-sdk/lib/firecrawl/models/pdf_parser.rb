# frozen_string_literal: true

module Firecrawl
  module Models
    # Configuration for parsing PDF documents.
    class PdfParser
      attr_reader :mode, :max_pages, :page_markdown

      def initialize(mode: nil, max_pages: nil, page_markdown: nil)
        @mode = mode
        @max_pages = max_pages
        @page_markdown = page_markdown
      end

      def to_h
        {
          "type" => "pdf",
          "mode" => mode,
          "maxPages" => max_pages,
          "pageMarkdown" => page_markdown,
        }.compact
      end
    end
  end
end
