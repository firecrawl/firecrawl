package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * A discovered video reference on a scraped page.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class VideoItem {
    private String url;

    @JsonProperty("sourceURL")
    private String sourceURL;

    private String source;
    private String kind;
    private String provider;
    private String title;
    private String thumbnail;
    private String description;
    private String duration;
    private String mimeType;
    private Integer width;
    private Integer height;
    private Map<String, Object> metadata;

    public String getUrl() { return url; }
    public String getSourceURL() { return sourceURL; }
    public String getSource() { return source; }
    public String getKind() { return kind; }
    public String getProvider() { return provider; }
    public String getTitle() { return title; }
    public String getThumbnail() { return thumbnail; }
    public String getDescription() { return description; }
    public String getDuration() { return duration; }
    public String getMimeType() { return mimeType; }
    public Integer getWidth() { return width; }
    public Integer getHeight() { return height; }
    public Map<String, Object> getMetadata() { return metadata; }
}
