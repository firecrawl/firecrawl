package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Typed layout blocks for a single PDF page, returned when
 * {@code parsers} includes {@code {type: "pdf", blocks: true}}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PdfPageBlocks {

    private int pageNumber;
    private Double width;
    private Double height;
    private String status;
    private List<PdfBlockItem> items;

    public int getPageNumber() { return pageNumber; }
    public Double getWidth() { return width; }
    public Double getHeight() { return height; }
    public String getStatus() { return status; }
    public List<PdfBlockItem> getItems() { return items; }

    @Override
    public String toString() {
        return "PdfPageBlocks{pageNumber=" + pageNumber + ", status=" + status + "}";
    }
}
