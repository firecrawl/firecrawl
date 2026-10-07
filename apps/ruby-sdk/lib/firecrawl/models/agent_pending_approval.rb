# frozen_string_literal: true

module Firecrawl
  module Models
    # A turn that ended waiting for the caller. kind "calls" (or nil on older
    # runs) holds paid calls to allow or refuse; kind "terms" lists providers
    # whose data terms need accepting, with calls empty. Answer it on the next
    # turn of the thread with AgentExchangeOptions approve or decline.
    class AgentPendingApproval
      # input and more are the raw call arguments.
      class Call
        attr_reader :id, :provider, :capability, :input, :more,
                    :credits_estimate

        def initialize(data)
          @id = data["id"]
          @provider = data["provider"]
          @capability = data["capability"]
          @input = data["input"]
          @more = data["more"]
          @credits_estimate = data["creditsEstimate"]
        end
      end

      class TermsGate
        attr_reader :provider, :name, :logo, :capability, :adds, :version,
                    :digest, :url

        def initialize(data)
          @provider = data["provider"]
          @name = data["name"]
          @logo = data["logo"]
          @capability = data["capability"]
          @adds = data["adds"]
          @version = data["version"]
          @digest = data["digest"]
          @url = data["url"]
        end
      end

      class Resolution
        attr_reader :approved, :call_ids, :always, :by_run_id

        def initialize(data)
          @approved = data["approved"]
          @call_ids = data["callIds"]
          @always = data["always"]
          @by_run_id = data["byRunId"]
        end
      end

      attr_reader :id, :kind, :reason, :calls, :terms, :resolution

      def initialize(data)
        @id = data["id"]
        @kind = data["kind"]
        @reason = data["reason"]
        @calls = data["calls"]&.map { |c| Call.new(c) }
        @terms = data["terms"]&.map { |t| TermsGate.new(t) }
        @resolution = data["resolution"] && Resolution.new(data["resolution"])
      end
    end
  end
end
