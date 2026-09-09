# frozen_string_literal: true

module Firecrawl
  module Models
    # Response from listing agent tasks.
    class AgentListResponse
      attr_reader :success, :agents, :next, :error

      def initialize(raw)
        @success = raw["success"]
        @agents = raw["agents"]
        @next = raw["next"]
        @error = raw["error"]
      end

      def to_s
        "AgentListResponse{success=#{success}, agents=#{agents&.size}}"
      end
    end
  end
end
