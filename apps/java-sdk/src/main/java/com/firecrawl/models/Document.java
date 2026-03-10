package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

/**
 * A scraped document returned by scrape, crawl, and batch endpoints.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Document {

    private String markdown;
    private String html;
    private String rawHtml;
    private Object json;
    private String summary;
    private Map<String, Object> metadata;
    private List<String> links;
    private List<String> images;
    private String screenshot;
    private List<Map<String, Object>> attributes;
    private Map<String, Object> actions;
    private String warning;
    private Map<String, Object> changeTracking;
    private Map<String, Object> branding;

    public String getMarkdown() { return markdown; }
    public String getHtml() { return html; }
    public String getRawHtml() { return rawHtml; }
    public Object getJson() { return json; }
    public String getSummary() { return summary; }
    public Map<String, Object> getMetadata() { return metadata; }
    public List<String> getLinks() { return links; }
    public List<String> getImages() { return images; }
    public String getScreenshot() { return screenshot; }
    public List<Map<String, Object>> getAttributes() { return attributes; }
    public Map<String, Object> getActions() { return actions; }
    public String getWarning() { return warning; }
    public Map<String, Object> getChangeTracking() { return changeTracking; }
    public Map<String, Object> getBranding() { return branding; }

    @Override
    public String toString() {
        String title = metadata != null ? String.valueOf(metadata.get("title")) : "untitled";
        String url = metadata != null ? String.valueOf(metadata.get("sourceURL")) : "unknown";
        return "Document{title=" + title + ", url=" + url + "}";
    }
}
