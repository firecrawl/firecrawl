# frozen_string_literal: true

module Firecrawl
  module Models
    # What an agent run did with Alexandria (Exchange). toolkits and
    # require_approval are what the run resolved to after thread inheritance.
    class AgentExchangeSummary
      # A provider that needs data terms the team has not accepted, so the run
      # did not use it.
      class SkippedProvider
        attr_reader :provider, :name, :capability, :adds, :reason, :version,
                    :terms_url

        def initialize(data)
          @provider = data["provider"]
          @name = data["name"]
          @capability = data["capability"]
          @adds = data["adds"]
          @reason = data["reason"]
          @version = data["version"]
          @terms_url = data["termsUrl"]
        end
      end

      # The Exchange calls to view and accept providers' terms ("ask" mode).
      # Nothing here runs for you; only call accept after your user agrees.
      class TermsRequiredAction
        # show and accept are the raw Exchange calls ("provider",
        # "capability", "options").
        class Provider
          attr_reader :provider, :name, :capability, :adds, :version, :digest,
                      :url, :show, :accept

          def initialize(data)
            @provider = data["provider"]
            @name = data["name"]
            @capability = data["capability"]
            @adds = data["adds"]
            @version = data["version"]
            @digest = data["digest"]
            @url = data["url"]
            @show = data["show"]
            @accept = data["accept"]
          end
        end

        attr_reader :type, :approval_id, :providers

        def initialize(data)
          @type = data["type"]
          @approval_id = data["approvalId"]
          @providers = data["providers"]&.map { |p| Provider.new(p) }
        end
      end

      attr_reader :enabled, :toolkits, :require_approval, :on_terms_required,
                  :paid_calls, :credits_used, :skipped_providers,
                  :requires_action

      def initialize(data)
        @enabled = data["enabled"]
        @toolkits = data["toolkits"]
        @require_approval = data["requireApproval"]
        @on_terms_required = data["onTermsRequired"]
        @paid_calls = data["paidCalls"]
        @credits_used = data["creditsUsed"]
        @skipped_providers = data["skippedProviders"]&.map { |p| SkippedProvider.new(p) }
        @requires_action = data["requiresAction"] && TermsRequiredAction.new(data["requiresAction"])
      end
    end
  end
end
