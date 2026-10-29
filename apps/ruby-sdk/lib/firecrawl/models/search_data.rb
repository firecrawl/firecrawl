# frozen_string_literal: true

module Firecrawl
  module Models
    # Search results from the v2 search API.
    class SearchData
      attr_reader :web, :news, :images

      def initialize(data)
        @web = data["web"]
        @news = data["news"]
        @images = data["images"]
      end

      def to_s
        web_count = web&.size || 0
        news_count = news&.size || 0
        image_count = images&.size || 0
        "SearchData{web=#{web_count}, news=#{news_count}, images=#{image_count}}"
      end
    end
  end
end
