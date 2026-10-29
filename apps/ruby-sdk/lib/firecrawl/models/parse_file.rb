# frozen_string_literal: true

module Firecrawl
  module Models
    # Binary upload payload for the `/v2/parse` endpoint.
    #
    # Supported file extensions: .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls
    class ParseFile
      attr_reader :filename, :content, :content_type

      # Build a ParseFile directly.
      #
      # @param filename [String] filename for the upload (e.g., "document.pdf")
      # @param content [String] raw bytes for the file
      # @param content_type [String, nil] optional MIME type hint
      def initialize(filename:, content:, content_type: nil)
        raise ArgumentError, "filename is required" if filename.nil? || filename.to_s.strip.empty?
        raise ArgumentError, "content is required" if content.nil? || content.bytesize.zero?

        @filename = filename.to_s.strip
        @content = content.to_s
        @content_type = content_type
      end

      # Build a ParseFile by reading a file from disk.
      #
      # @param path [String] absolute or relative path to the file
      # @param filename [String, nil] optional override for the upload filename
      # @param content_type [String, nil] optional MIME type hint
      # @return [ParseFile]
      def self.from_path(path, filename: nil, content_type: nil)
        raise ArgumentError, "path is required" if path.nil? || path.to_s.strip.empty?
        unless File.file?(path)
          raise ArgumentError, "file path does not exist: #{path}"
        end

        content = File.binread(path)
        resolved_filename = filename || File.basename(path)
        resolved_content_type = content_type || guess_content_type(resolved_filename)
        new(filename: resolved_filename, content: content, content_type: resolved_content_type)
      end

      # @api private
      def self.guess_content_type(filename)
        ext = File.extname(filename).downcase
        {
          ".pdf" => "application/pdf",
          ".html" => "text/html",
          ".htm" => "text/html",
          ".xhtml" => "application/xhtml+xml",
          ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".doc" => "application/msword",
          ".odt" => "application/vnd.oasis.opendocument.text",
          ".rtf" => "application/rtf",
          ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ".xls" => "application/vnd.ms-excel",
        }[ext]
      end
    end
  end
end
