# frozen_string_literal: true

module Firecrawl
  module Models
    # A file format accepted by the `/v2/parse` endpoint.
    #
    # `kind` is usually one of {KIND_DOCUMENT} or {KIND_IMAGE}, but newer API
    # versions may return other values, which are kept as-is.
    class ParseFormat
      KIND_DOCUMENT = "document"
      KIND_IMAGE = "image"

      attr_reader :format, :kind, :extensions, :mime_types, :available

      def initialize(data)
        @format = data["format"]
        @kind = data["kind"]
        @extensions = data["extensions"] || []
        @mime_types = data["mimeTypes"] || []
        @available = data["available"]
      end

      def document?
        kind == KIND_DOCUMENT
      end

      def image?
        kind == KIND_IMAGE
      end

      def to_s
        "ParseFormat{format=#{format}, kind=#{kind}, available=#{available}}"
      end
    end
  end
end
