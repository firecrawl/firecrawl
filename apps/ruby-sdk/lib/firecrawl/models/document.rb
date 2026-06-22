# frozen_string_literal: true

module Firecrawl
  module Models
    # A scraped document returned by scrape, crawl, and batch endpoints.
    class Document
      attr_reader :markdown, :html, :raw_html, :json, :summary,
                  :metadata, :links, :images, :screenshot, :audio,
                  :video, :attributes, :actions, :answer, :highlights,
                  :warning, :change_tracking, :branding, :product, :menu

      def initialize(data)
        @markdown = data["markdown"]
        @html = data["html"]
        @raw_html = data["rawHtml"]
        @json = data["json"]
        @summary = data["summary"]
        @metadata = data["metadata"]
        @links = data["links"]
        @images = data["images"]
        @screenshot = data["screenshot"]
        @audio = data["audio"]
        @video = data["video"]
        @attributes = data["attributes"]
        @actions = data["actions"]
        @answer = data["answer"]
        @highlights = data["highlights"]
        @warning = data["warning"]
        @change_tracking = data["changeTracking"]
        @branding = data["branding"]
        @product = data["product"] && ProductProfile.new(data["product"])
        @menu = data["menu"] && MenuProfile.new(data["menu"])
      end

      def to_s
        title = metadata&.dig("title") || "untitled"
        url = metadata&.dig("sourceURL") || "unknown"
        "Document{title=#{title}, url=#{url}}"
      end
    end
  end
end
