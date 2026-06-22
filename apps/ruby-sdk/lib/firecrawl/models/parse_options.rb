# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for parsing uploaded files via `/v2/parse`.
    #
    # Parse does not support browser-rendering features (actions, waitFor,
    # location, mobile) nor screenshot/branding/product/menu/audio/video/changeTracking formats. The
    # proxy field only accepts "auto" or "basic".
    class ParseOptions
      UNSUPPORTED_FORMATS = %w[changeTracking screenshot screenshot@fullPage branding product menu audio video].freeze

      FIELDS = %i[
        formats headers include_tags exclude_tags only_main_content
        timeout parsers skip_tls_verification remove_base64_images
        block_ads proxy integration redact_pii json_options
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }

        validate!
      end

      def to_h
        {
          "formats" => formats&.map { |fmt| format_value(fmt) },
          "headers" => headers,
          "includeTags" => include_tags,
          "excludeTags" => exclude_tags,
          "onlyMainContent" => only_main_content,
          "timeout" => timeout,
          "parsers" => parsers,
          "skipTlsVerification" => skip_tls_verification,
          "removeBase64Images" => remove_base64_images,
          "blockAds" => block_ads,
          "proxy" => proxy,
          "integration" => integration,
          "redactPII" => redact_pii,
          "jsonOptions" => json_options.is_a?(Hash) ? json_options : json_options&.to_h,
        }.compact
      end

      private

      def validate!
        if !timeout.nil? && timeout.to_i <= 0
          raise ArgumentError, "timeout must be positive"
        end

        if !proxy.nil? && !proxy.to_s.empty? && !%w[auto basic].include?(proxy.to_s)
          raise ArgumentError, "parse only supports proxy values 'auto' or 'basic'"
        end

        (formats || []).each do |fmt|
          type = extract_format_type(fmt)
          if UNSUPPORTED_FORMATS.include?(type)
            raise ArgumentError, "parse does not support format: #{type}"
          end
        end
      end

      def extract_format_type(fmt)
        case fmt
        when String then fmt
        when Hash then fmt["type"] || fmt[:type]
        else
          fmt.respond_to?(:type) ? fmt.type : nil
        end
      end

      def format_value(fmt)
        fmt.respond_to?(:to_h) ? fmt.to_h : fmt
      end
    end
  end
end
