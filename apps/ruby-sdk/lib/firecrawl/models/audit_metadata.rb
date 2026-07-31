# frozen_string_literal: true

module Firecrawl
  module Models
    # User attribution included with SIEM logging events.
    class AuditMetadata
      attr_reader :username

      def initialize(username:)
        raise ArgumentError, "username must be a string" unless username.is_a?(String)

        @username = username
      end

      def to_h
        { "username" => username }
      end
    end
  end
end
