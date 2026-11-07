# frozen_string_literal: true

module Firecrawl
  module Models
    # Status response for monitoring agent tasks.
    class AgentStatusResponse
      attr_reader :status, :data, :credits_used, :expires_at, :effort,
                  :thread_id, :thread_turn, :mode, :message, :pending_approval,
                  :exchange

      def initialize(raw)
        @status = raw["status"]
        @data = raw["data"]
        @credits_used = raw["creditsUsed"]
        @expires_at = raw["expiresAt"]
        # The effort the job ran with; only present for runs that specified it.
        @effort = raw["effort"]
        @thread_id = raw["threadId"]
        @thread_turn = raw["threadTurn"]
        @mode = raw["mode"]
        # Chat-mode runs answer here instead of in data.
        @message = raw["message"]
        @pending_approval = raw["pendingApproval"] && AgentPendingApproval.new(raw["pendingApproval"])
        @exchange = raw["exchange"] && AgentExchangeSummary.new(raw["exchange"])
      end

      def done?
        %w[completed failed cancelled].include?(status)
      end

      def to_s
        "AgentStatusResponse{status=#{status}}"
      end
    end
  end
end
