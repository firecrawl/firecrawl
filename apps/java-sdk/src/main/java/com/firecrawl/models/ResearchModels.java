package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

public final class ResearchModels {
    private ResearchModels() {}

    public static class PaperResult {
        @JsonProperty("paperId")
        public String paperId;
        @JsonProperty("primaryId")
        public String primaryId;
        public Map<String, Object> ids;
        public String title;
        @JsonProperty("abstract")
        public String abstractText;
        public Double score;
        public Integer year;
        public List<String> authors;
        public String venue;
        public String url;
        public Map<String, Object> signals;
    }

    public static class PaperMetadata {
        @JsonProperty("paperId")
        public String paperId;
        public Map<String, Object> ids;
        public String title;
        @JsonProperty("abstract")
        public String abstractText;
        public String authors;
        public List<String> categories;
        @JsonProperty("createdDate")
        public String createdDate;
        @JsonProperty("updateDate")
        public String updateDate;
    }

    public static class Passage {
        public String text;
        public String section;
        public Integer page;
        public Double score;
        public Map<String, Object> metadata;
    }

    public static class SearchPapersResponse {
        public boolean success;
        public List<PaperResult> results;
    }

    public static class PaperMetadataResponse {
        public boolean success;
        public PaperMetadata paper;
    }

    public static class ReadPaperResponse {
        public boolean success;
        public PaperMetadata paper;
        @JsonProperty("paperId")
        public String paperId;
        public String query;
        public List<Passage> passages;
    }

    public static class SimilarPapersResponse {
        public boolean success;
        public List<PaperResult> results;
        @JsonProperty("poolSize")
        public Integer poolSize;
        public boolean truncated;
        public String note;
    }

    public static class GitHubSearchItem {
        public String resultType;
        public String repo;
        public String url;
        public String pageType;
        public Integer number;
        public Integer segmentCount;
        public String readmeUrl;
        public String title;
        public String snippet;
        public String contentMd;
        public Map<String, Object> scores;
    }

    public static class GitHubSearchResponse {
        public boolean success;
        public List<GitHubSearchItem> results;
    }

    public static class SearchPapersOptions {
        public Integer k;
        public List<String> authors;
        public List<String> categories;
        public String from;
        public String to;
    }

    public static class ReadPaperOptions {
        public Integer k;
    }

    public static class RelatedPapersOptions {
        public String mode;
        public Integer k;
        public Boolean rerank;
        public List<String> anchor;
    }

    public static class SearchGitHubOptions {
        public Integer k;
    }

    /** Options for {@code developerSearch}. Unset fields are omitted from the request. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class DeveloperSearchOptions {
        /** Total ranked results, 1 to 100 (default 10). */
        public Integer k;
        /** Passages per result, 1 to 5 (default 1). */
        public Integer passages;
        /** Result kinds: "doc", "issue", "pull_request", "readme" (default all). */
        public List<String> types;
        /** GitHub owner/name filters, at most 20. */
        public List<String> repos;
        /** Developer documentation source IDs, at most 20. */
        public List<String> sources;
        /** One case-insensitive GitHub Linguist primary language. */
        public String language;
        /** Repository topics that must all match, at most 8. */
        public List<String> topic;
        /** One case-insensitive SPDX repository license identifier. */
        public String license;
        @JsonProperty("min_stars")
        public Long minStars;
        @JsonProperty("max_stars")
        public Long maxStars;
        public Boolean archived;
        public Boolean fork;
        /** "only" returns packaged agent-skill evidence only. */
        public String skills;
    }

    public static class DeveloperSearchPassage {
        public String text;
        @JsonProperty("citation_url")
        public String citationUrl;
    }

    /** One ranked developer search result. {@code license} is an SPDX string or a disclosure map. */
    public static class DeveloperSearchResult {
        public String id;
        public String url;
        public String title;
        public List<DeveloperSearchPassage> passages;
        public Object license;
    }

    public static class DeveloperSearchRepoTypes {
        public boolean issue;
        @JsonProperty("pullRequest")
        public boolean pullRequest;
        public boolean readme;
    }

    public static class DeveloperSearchRepoStatus {
        public String repo;
        public boolean indexed;
        public DeveloperSearchRepoTypes types;
    }

    public static class DeveloperSearchSourceStatus {
        public String source;
        public boolean indexed;
    }

    /** Response from {@code developerSearch}. {@code repos} and {@code sources} are set only when those filters were requested. */
    public static class DeveloperSearchResponse {
        public boolean success;
        public List<DeveloperSearchResult> results;
        public List<DeveloperSearchRepoStatus> repos;
        public List<DeveloperSearchSourceStatus> sources;
    }
}
