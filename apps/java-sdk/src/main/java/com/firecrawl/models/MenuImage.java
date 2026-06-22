package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * An image associated with a menu item extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuImage {

    private String url;
    private String alt;

    public String getUrl() { return url; }
    public String getAlt() { return alt; }

    @Override
    public String toString() {
        return "MenuImage{url=" + url + "}";
    }
}
