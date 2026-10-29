# frozen_string_literal: true

module Firecrawl
  module Models
    # Credit usage information.
    class CreditUsage
      attr_reader :remaining_credits, :plan_credits,
                  :billing_period_start, :billing_period_end

      def initialize(data)
        @remaining_credits = data["remainingCredits"]
        @plan_credits = data["planCredits"]
        @billing_period_start = data["billingPeriodStart"]
        @billing_period_end = data["billingPeriodEnd"]
      end

      def to_s
        "CreditUsage{remaining=#{remaining_credits}/#{plan_credits}}"
      end
    end
  end
end
