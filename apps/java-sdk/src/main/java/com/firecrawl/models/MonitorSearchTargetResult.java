package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Per-target result for a search monitor target ({@code type = "search"}).
 *
 * <p>Reported on a {@link MonitorCheck}'s {@code targetResults} for each search target,
 * summarizing how the check's queries performed and what the judge concluded.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorSearchTargetResult {
    private String targetId;
    private String type = "search";
    private Boolean searchCompleted;
    private Integer resultCount;
    private Integer matches;
    private String summary;
    private Boolean judgeDegraded;
    private String degradedReason;
    private Number searchCredits;
    private Number judgeCredits;
    private Integer resultsJudged;

    public String getTargetId() { return targetId; }
    /** Always {@code "search"}. */
    public String getType() { return type; }
    public Boolean getSearchCompleted() { return searchCompleted; }
    public Integer getResultCount() { return resultCount; }
    public Integer getMatches() { return matches; }
    public String getSummary() { return summary; }
    public Boolean getJudgeDegraded() { return judgeDegraded; }
    /** Nullable reason the judge was degraded for this target. */
    public String getDegradedReason() { return degradedReason; }
    public Number getSearchCredits() { return searchCredits; }
    public Number getJudgeCredits() { return judgeCredits; }
    public Integer getResultsJudged() { return resultsJudged; }
}
