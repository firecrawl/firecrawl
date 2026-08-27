# frozen_string_literal: true

module Firecrawl
  module Models
    # Trace response for an agent task.
    #
    # Events are raw hashes: each carries a "type" (e.g. "run.started",
    # "agent.finished", "tool_call.started") plus base fields like
    # "schemaVersion", "eventId", "runId", "occurredAt", "producerSequence",
    # and "agent".
    class AgentTraceResponse
      attr_reader :success, :id, :events, :active_browser_sessions, :credits_used, :error

      def initialize(raw)
        @success = raw["success"]
        @id = raw["id"]
        @events = raw["events"]
        @active_browser_sessions = raw["activeBrowserSessions"]
        @credits_used = raw["creditsUsed"]
        @error = raw["error"]
      end

      def to_s
        "AgentTraceResponse{id=#{id}, success=#{success}}"
      end
    end
  end
end
