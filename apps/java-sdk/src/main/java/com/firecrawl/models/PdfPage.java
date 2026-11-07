package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Physical markdown for a single PDF page, returned when
 * {@code parsers} includes {@code {type: "pdf", pages: true}}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PdfPage {

    private int pageNumber;
    private String markdown;

    public int getPageNumber() { return pageNumber; }
    public String getMarkdown() { return markdown; }

    @Override
    public String toString() {
        return "PdfPage{pageNumber=" + pageNumber + "}";
    }
}
