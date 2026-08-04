# frozen_string_literal: true

module Firecrawl
  module Models
    # Markdown extracted from a single PDF page.
    class DocumentPage
      attr_reader :page_number, :markdown

      def initialize(data)
        @page_number = data["pageNumber"]
        @markdown = data["markdown"]
      end
    end
  end
end
