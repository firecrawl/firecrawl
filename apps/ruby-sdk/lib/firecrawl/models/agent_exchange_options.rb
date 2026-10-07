# frozen_string_literal: true

module Firecrawl
  module Models
    # Alexandria (Exchange) options for an agent run, forwarded verbatim; the
    # server owns every default and limit. On a follow-up turn, omitting the
    # exchange options inherits the previous turn's settings.
    #
    # on_terms_required: "skip" or "ask".
    class AgentExchangeOptions
      # Answers the previous turn's pending approval. A "terms" approval is
      # accepted as a whole, so call_ids and always are ignored on it.
      class Approve
        attr_reader :approval_id, :call_ids, :always

        def initialize(approval_id:, call_ids: nil, always: nil)
          @approval_id = approval_id
          @call_ids = call_ids
          @always = always
        end

        def to_h
          {
            "approvalId" => approval_id,
            "callIds" => call_ids,
            "always" => always,
          }.compact
        end
      end

      # Refuses the previous turn's pending approval.
      class Decline
        attr_reader :approval_id

        def initialize(approval_id:)
          @approval_id = approval_id
        end

        def to_h
          { "approvalId" => approval_id }
        end
      end

      FIELDS = %i[
        enabled toolkits max_calls require_approval approve decline
        on_terms_required
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
      end

      def to_h
        {
          "enabled" => enabled,
          "toolkits" => toolkits,
          "maxCalls" => max_calls,
          "requireApproval" => require_approval,
          "approve" => approve&.to_h,
          "decline" => decline&.to_h,
          "onTermsRequired" => on_terms_required,
        }.compact
      end
    end
  end
end
