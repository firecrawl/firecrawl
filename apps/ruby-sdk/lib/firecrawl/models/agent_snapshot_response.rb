# frozen_string_literal: true

module Firecrawl
  module Models
    # Snapshot response for an agent task.
    class AgentSnapshotResponse
      attr_reader :success, :id, :snapshot_id, :snapshot, :error

      def initialize(raw)
        @success = raw["success"]
        @id = raw["id"]
        @snapshot_id = raw["snapshotId"]
        @snapshot = raw["snapshot"]
        @error = raw["error"]
      end

      def to_s
        "AgentSnapshotResponse{id=#{id}, snapshot_id=#{snapshot_id}, success=#{success}}"
      end
    end
  end
end
