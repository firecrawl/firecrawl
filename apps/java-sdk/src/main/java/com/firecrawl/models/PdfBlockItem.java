package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * A typed PDF layout block (bounding box, type, reading order).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PdfBlockItem {

    private String id;
    private String type;
    private String label;
    private List<Double> bbox;
    private String content;
    private List<Integer> markdownSpan;
    private int readingOrder;
    private String source;
    private PdfBlockConfidence confidence;

    public String getId() { return id; }
    public String getType() { return type; }
    public String getLabel() { return label; }
    public List<Double> getBbox() { return bbox; }
    public String getContent() { return content; }
    public List<Integer> getMarkdownSpan() { return markdownSpan; }
    public int getReadingOrder() { return readingOrder; }
    public String getSource() { return source; }
    public PdfBlockConfidence getConfidence() { return confidence; }

    @Override
    public String toString() {
        return "PdfBlockItem{id=" + id + ", type=" + type + "}";
    }
}
