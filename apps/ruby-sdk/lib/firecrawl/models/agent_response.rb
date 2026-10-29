# frozen_string_literal: true

module Firecrawl
  module Models
    # Response from starting an agent task.
    class AgentResponse
      attr_reader :success, :id, :error, :thread_id, :thread_turn

      def initialize(data)
        @success = data["success"]
        @id = data["id"]
        @error = data["error"]
        # Pass thread_id back in AgentOptions to continue the conversation.
        @thread_id = data["threadId"]
        @thread_turn = data["threadTurn"]
      end

      def to_s
        "AgentResponse{id=#{id}, success=#{success}}"
      end
    end
  end
end
