package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Configuration for parsing PDF documents.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PdfParser {

    private final String type = "pdf";
    private String mode;
    private Integer maxPages;
    private Boolean pageMarkdown;

    private PdfParser() {}

    public String getType() { return type; }
    public String getMode() { return mode; }
    public Integer getMaxPages() { return maxPages; }
    public Boolean getPageMarkdown() { return pageMarkdown; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String mode;
        private Integer maxPages;
        private Boolean pageMarkdown;

        private Builder() {}

        public Builder mode(String mode) { this.mode = mode; return this; }
        public Builder maxPages(Integer maxPages) { this.maxPages = maxPages; return this; }
        public Builder pageMarkdown(Boolean pageMarkdown) { this.pageMarkdown = pageMarkdown; return this; }

        public PdfParser build() {
            PdfParser parser = new PdfParser();
            parser.mode = this.mode;
            parser.maxPages = this.maxPages;
            parser.pageMarkdown = this.pageMarkdown;
            return parser;
        }
    }
}
