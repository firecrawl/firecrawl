# frozen_string_literal: true

module Firecrawl
  module Models
    # Structured menu information extracted from a restaurant/merchant page
    # via the `menu` scrape format.
    class MenuProfile
      # An image associated with a menu item.
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

      # Stock availability information for a menu item. Always present.
      class Availability
        attr_reader :in_stock, :text

        def initialize(data)
          data ||= {}
          @in_stock = data["inStock"] || false
          @text = data["text"]
        end
      end

      # Merchant (restaurant/business) profile for the menu.
      class Merchant
        attr_reader :name, :type, :location

        def initialize(data)
          data ||= {}
          @name = data["name"]
          @type = data["type"]
          @location = data["location"]
        end
      end

      # Identifiers carried on a menu item.
      class Identifiers
        attr_reader :merchant_item_id

        def initialize(data)
          data ||= {}
          @merchant_item_id = data["merchantItemId"]
        end
      end

      # A single item on the menu. Pricing, availability, images, and dietary
      # information live here rather than on the section or profile.
      class Item
        attr_reader :id, :name, :description, :images, :price, :availability,
                    :dietary, :calories, :option_groups, :identifiers, :url,
                    :source_url

        def initialize(data)
          @id = data["id"]
          @name = data["name"]
          @description = data["description"]
          @images = (data["images"] || []).map { |img| Image.new(img) }
          @price = data["price"] && Price.new(data["price"])
          @availability = Availability.new(data["availability"])
          @dietary = data["dietary"] || []
          @calories = data["calories"]
          @option_groups = data["optionGroups"] || []
          @identifiers = Identifiers.new(data["identifiers"])
          @url = data["url"]
          @source_url = data["sourceUrl"]
        end
      end

      # An ordered group of menu items.
      class Section
        attr_reader :id, :name, :description, :items

        def initialize(data)
          @id = data["id"]
          @name = data["name"]
          @description = data["description"]
          @items = (data["items"] || []).map { |item| Item.new(item) }
        end
      end

      attr_reader :is_menu, :confidence, :merchant, :currency, :sections,
                  :source_url

      def initialize(data)
        @is_menu = data["isMenu"] || false
        @confidence = data["confidence"]
        @merchant = Merchant.new(data["merchant"])
        @currency = data["currency"]
        @sections = (data["sections"] || []).map { |section| Section.new(section) }
        @source_url = data["sourceUrl"]
      end

      def to_s
        "MenuProfile{merchant=#{merchant&.name || 'unknown'}, sourceUrl=#{source_url || 'unknown'}}"
      end
    end
  end
end
