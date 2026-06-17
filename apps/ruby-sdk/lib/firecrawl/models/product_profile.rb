# frozen_string_literal: true

module Firecrawl
  module Models
    # Structured product information extracted from a product page via the
    # `product` scrape format.
    class ProductProfile
      # An image associated with a product or variant.
      class Image
        attr_reader :url, :alt

        def initialize(data)
          @url = data["url"]
          @alt = data["alt"]
        end
      end

      # A monetary value with an optional currency and formatted string.
      class Price
        attr_reader :amount, :currency, :formatted

        def initialize(data)
          @amount = data["amount"]
          @currency = data["currency"]
          @formatted = data["formatted"]
        end
      end

      # Stock availability information for a product or variant.
      class Availability
        attr_reader :in_stock, :text

        def initialize(data)
          @in_stock = data["inStock"]
          @text = data["text"]
        end
      end

      # A purchasable variant of a product.
      class Variant
        attr_reader :id, :sku, :title, :values, :price, :original_price,
                    :availability, :images

        def initialize(data)
          @id = data["id"]
          @sku = data["sku"]
          @title = data["title"]
          @values = data["values"]
          @price = data["price"] && Price.new(data["price"])
          @original_price = data["originalPrice"] && Price.new(data["originalPrice"])
          @availability = data["availability"] && Availability.new(data["availability"])
          @images = (data["images"] || []).map { |img| Image.new(img) }
        end
      end

      attr_reader :title, :brand, :category, :url, :description, :images,
                  :price, :original_price, :availability, :variants

      def initialize(data)
        @title = data["title"]
        @brand = data["brand"]
        @category = data["category"]
        @url = data["url"]
        @description = data["description"]
        @images = (data["images"] || []).map { |img| Image.new(img) }
        @price = data["price"] && Price.new(data["price"])
        @original_price = data["originalPrice"] && Price.new(data["originalPrice"])
        @availability = data["availability"] && Availability.new(data["availability"])
        @variants = (data["variants"] || []).map { |variant| Variant.new(variant) }
      end

      def to_s
        "ProductProfile{title=#{title || 'untitled'}, url=#{url || 'unknown'}}"
      end
    end
  end
end
