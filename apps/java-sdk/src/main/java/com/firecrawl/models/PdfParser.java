package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * PDF parser configuration for use in {@code ScrapeOptions.parsers} /
 * {@code ParseOptions.parsers}.
 *
 * <p>Usage:
 * <pre>{@code
 * PdfParser pdf = PdfParser.builder()
 *     .mode("auto")
 *     .pages(true)
 *     .blocks(true)
 *     .pageMarkers(true)
 *     .build();
 * }</pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PdfParser {

    private final String type = "pdf";
    private String mode;
    @JsonProperty("maxPages")
    private Integer maxPages;
    private Boolean pages;
    private Boolean blocks;
    @JsonProperty("pageMarkers")
    private Boolean pageMarkers;

    private PdfParser() {}

    public String getType() { return type; }
    public String getMode() { return mode; }
    @JsonProperty("maxPages")
    public Integer getMaxPages() { return maxPages; }
    public Boolean getPages() { return pages; }
    public Boolean getBlocks() { return blocks; }
    @JsonProperty("pageMarkers")
    public Boolean getPageMarkers() { return pageMarkers; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String mode;
        private Integer maxPages;
        private Boolean pages;
        private Boolean blocks;
        private Boolean pageMarkers;

        private Builder() {}

        /** PDF processing mode: {@code "fast"}, {@code "auto"}, or {@code "ocr"}. */
        public Builder mode(String mode) { this.mode = mode; return this; }

        /** Maximum number of PDF pages to process. */
        public Builder maxPages(Integer maxPages) { this.maxPages = maxPages; return this; }

        /** Include physical per-page markdown. Populates {@code document.pages}. */
        public Builder pages(Boolean pages) { this.pages = pages; return this; }

        /** Include per-page typed layout blocks. Populates {@code document.blocks}. */
        public Builder blocks(Boolean blocks) { this.blocks = blocks; return this; }

        /**
         * Join PDF pages in {@code document.markdown} with
         * {@code \n\n---\n\n<!-- page N -->\n\n}. Markers appear between pages
         * only; numbering may skip pages merged by cross-page stitching — use
         * {@code pages(true)} when every physical page is needed.
         */
        public Builder pageMarkers(Boolean pageMarkers) { this.pageMarkers = pageMarkers; return this; }

        public PdfParser build() {
            PdfParser p = new PdfParser();
            p.mode = this.mode;
            p.maxPages = this.maxPages;
            p.pages = this.pages;
            p.blocks = this.blocks;
            p.pageMarkers = this.pageMarkers;
            return p;
        }
    }
}
