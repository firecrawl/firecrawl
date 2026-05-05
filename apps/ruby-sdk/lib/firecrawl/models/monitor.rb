# frozen_string_literal: true

module Firecrawl
  module Models
    class Monitor
      attr_reader :id, :name, :status, :schedule, :next_run_at, :last_run_at,
                  :current_check_id, :targets, :webhook, :notification,
                  :retention_days, :estimated_credits_per_month,
                  :last_check_summary, :created_at, :updated_at

      def initialize(data)
        @id = data["id"]
        @name = data["name"]
        @status = data["status"]
        @schedule = data["schedule"]
        @next_run_at = data["nextRunAt"]
        @last_run_at = data["lastRunAt"]
        @current_check_id = data["currentCheckId"]
        @targets = data["targets"] || []
        @webhook = data["webhook"]
        @notification = data["notification"]
        @retention_days = data["retentionDays"]
        @estimated_credits_per_month = data["estimatedCreditsPerMonth"]
        @last_check_summary = data["lastCheckSummary"]
        @created_at = data["createdAt"]
        @updated_at = data["updatedAt"]
      end
    end

    class MonitorCheck
      attr_reader :id, :monitor_id, :status, :trigger, :scheduled_for,
                  :started_at, :finished_at, :estimated_credits,
                  :reserved_credits, :actual_credits, :billing_status,
                  :summary, :target_results, :notification_status, :error,
                  :created_at, :updated_at

      def initialize(data)
        @id = data["id"]
        @monitor_id = data["monitorId"]
        @status = data["status"]
        @trigger = data["trigger"]
        @scheduled_for = data["scheduledFor"]
        @started_at = data["startedAt"]
        @finished_at = data["finishedAt"]
        @estimated_credits = data["estimatedCredits"]
        @reserved_credits = data["reservedCredits"]
        @actual_credits = data["actualCredits"]
        @billing_status = data["billingStatus"]
        @summary = data["summary"] || {}
        @target_results = data["targetResults"]
        @notification_status = data["notificationStatus"]
        @error = data["error"]
        @created_at = data["createdAt"]
        @updated_at = data["updatedAt"]
      end
    end

    class MonitorCheckDetail < MonitorCheck
      attr_accessor :pages, :next_url

      def initialize(data)
        super
        @pages = data["pages"] || []
        @next_url = data["next"]
      end
    end
  end
end
