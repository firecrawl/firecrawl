package com.firecrawl.models;

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
}
