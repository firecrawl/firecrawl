# frozen_string_literal: true

module Firecrawl
  module Models
    # A scrape, crawl, or search target stored on a monitor.
    #
    # Targets are forwarded to the API verbatim, so callers may also pass
    # plain Hashes with camelCase keys. This class is a convenience for
    # building well-formed target payloads (and is what {#to_h} emits).
    #
    # Search targets (+type: "search"+) use the +queries+, +search_window+,
    # +include_domains+, +exclude_domains+, and +max_results+ fields.
    class MonitorTarget
      attr_reader :id, :type, :urls, :url, :scrape_options, :crawl_options,
                  :queries, :search_window, :include_domains,
                  :exclude_domains, :max_results

      def initialize(data)
        @id = data["id"]
        @type = data["type"]
        @urls = data["urls"]
        @url = data["url"]
        @scrape_options = data["scrapeOptions"]
        @crawl_options = data["crawlOptions"]
        # search target fields
        @queries = data["queries"]
        @search_window = data["searchWindow"]
        @include_domains = data["includeDomains"]
        @exclude_domains = data["excludeDomains"]
        @max_results = data["maxResults"]
      end

      def to_h
        {
          "id" => @id,
          "type" => @type,
          "urls" => @urls,
          "url" => @url,
          "scrapeOptions" => @scrape_options,
          "crawlOptions" => @crawl_options,
          "queries" => @queries,
          "searchWindow" => @search_window,
          "includeDomains" => @include_domains,
          "excludeDomains" => @exclude_domains,
          "maxResults" => @max_results,
        }.compact
      end
    end

    # A per-target result on a monitor check.
    #
    # Search targets (+type: "search"+) populate the +search_completed+,
    # +result_count+, +matches+, +summary+, +judge_degraded+,
    # +degraded_reason+, +search_credits+, +judge_credits+, and
    # +results_judged+ fields.
    class MonitorTargetResult
      attr_reader :target_id, :type, :expected_jobs, :crawl_id,
                  :search_completed, :result_count, :matches, :summary,
                  :judge_degraded, :degraded_reason, :search_credits,
                  :judge_credits, :results_judged

      def initialize(data)
        @target_id = data["targetId"]
        @type = data["type"]
        @expected_jobs = data["expectedJobs"]
        @crawl_id = data["crawlId"]
        # search target result fields
        @search_completed = data["searchCompleted"]
        @result_count = data["resultCount"]
        @matches = data["matches"]
        @summary = data["summary"]
        @judge_degraded = data["judgeDegraded"]
        @degraded_reason = data["degradedReason"]
        @search_credits = data["searchCredits"]
        @judge_credits = data["judgeCredits"]
        @results_judged = data["resultsJudged"]
      end
    end

    class Monitor
      attr_reader :id, :name, :status, :schedule, :next_run_at, :last_run_at,
                  :current_check_id, :targets, :webhook, :notification,
                  :retention_days, :estimated_credits_per_month,
                  :last_check_summary, :goal, :judge_enabled,
                  :created_at, :updated_at

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
        @goal = data["goal"]
        @judge_enabled = data["judgeEnabled"] || false
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

    # A monitor check with paginated page results inlined.
    #
    # Each entry in {#pages} is a {Hash} with the standard monitor page
    # fields (id, targetId, url, status, previousScrapeId,
    # currentScrapeId, statusCode, error, metadata, createdAt) plus:
    #
    # * +"diff"+  – when the page changed. A hash with +"text"+ (markdown
    #   unified diff) and/or +"json"+ (parseDiff AST for markdown
    #   monitors, or a per-field +{ "previous", "current" }+ map for
    #   JSON-extraction monitors).
    # * +"snapshot"+ – present on JSON / mixed-mode monitors. A hash
    #   with a +"json"+ key holding the current JSON extraction at this
    #   run.
    # * +"judgment"+ – present when the monitor has a +goal+ set and
    #   judging is enabled. A hash with +"meaningful"+ (Boolean),
    #   +"confidence"+ (+"high"+ / +"medium"+ / +"low"+), +"reason"+
    #   (String), and +"fields"+ (Array of String) describing which
    #   fields the judge weighed.
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
