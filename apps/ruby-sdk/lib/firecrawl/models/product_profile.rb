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

      # Stock availability information for a variant. Always present.
      class Availability
        attr_reader :in_stock, :text

        def initialize(data)
          data ||= {}
          @in_stock = data["inStock"] || false
          @text = data["text"]
        end
      end

      # Sale pricing for a variant, carrying the pre-sale original price.
      class Sale
        attr_reader :original_price

        def initialize(data)
          @original_price = data["originalPrice"] && Price.new(data["originalPrice"])
        end
      end

      # A purchasable variant of a product. Pricing, availability, and images
      # live here rather than on the top-level product.
      class Variant
        attr_reader :id, :sku, :title, :values, :price, :sale,
                    :availability, :images

        def initialize(data)
          @id = data["id"]
          @sku = data["sku"]
          @title = data["title"]
          @values = data["values"]
          @price = data["price"] && Price.new(data["price"])
          @sale = data["sale"] && Sale.new(data["sale"])
          @availability = Availability.new(data["availability"])
          @images = (data["images"] || []).map { |img| Image.new(img) }
        end
      end

      attr_reader :title, :brand, :category, :url, :description, :variants

      def initialize(data)
        @title = data["title"]
        @brand = data["brand"]
        @category = data["category"]
        @url = data["url"]
        @description = data["description"]
        @variants = (data["variants"] || []).map { |variant| Variant.new(variant) }
      end

      def to_s
        "ProductProfile{title=#{title || 'untitled'}, url=#{url || 'unknown'}}"
      end
    end
  end
end
