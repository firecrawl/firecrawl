package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Markdown extracted from a single PDF page.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class DocumentPage {

    private int pageNumber;
    private String markdown;

    public int getPageNumber() { return pageNumber; }
    public String getMarkdown() { return markdown; }
}
