# frozen_string_literal: true

module Firecrawl
  module Models
    # Options for starting an agent task.
    #
    # effort: valid values are "low", "medium", and "high"; sets the reasoning
    # budget for the run (every level runs spark-2).
    #
    # thread_id continues an existing thread as its next turn; omitted starts a
    # new thread. mode: "extract" or "chat".
    class AgentOptions
      FIELDS = %i[
        urls prompt schema integration max_credits
        strict_constrain_to_urls model effort webhook audit_metadata
        thread_id mode exchange
      ].freeze

      attr_reader(*FIELDS)

      def initialize(**kwargs)
        FIELDS.each { |f| instance_variable_set(:"@#{f}", kwargs[f]) }
        if audit_metadata && !audit_metadata.is_a?(AuditMetadata)
          raise ArgumentError, "audit_metadata must be an AuditMetadata"
        end
        raise ArgumentError, "Agent prompt is required" if prompt.nil? || prompt.empty?
      end

      def to_h
        {
          "urls" => urls,
          "prompt" => prompt,
          "schema" => schema,
          "integration" => integration,
          "maxCredits" => max_credits,
          "strictConstrainToURLs" => strict_constrain_to_urls,
          "model" => model,
          "effort" => effort,
          "webhook" => webhook.is_a?(Hash) ? webhook : webhook&.to_h,
          "auditMetadata" => audit_metadata&.to_h,
          "threadId" => thread_id,
          "mode" => mode,
          "exchange" => exchange&.to_h,
        }.compact
      end
    end
  end
end
