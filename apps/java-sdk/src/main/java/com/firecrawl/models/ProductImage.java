package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * An image associated with a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductImage {

    private String url;
    private String alt;

    public String getUrl() { return url; }
    public String getAlt() { return alt; }

    @Override
    public String toString() {
        return "ProductImage{url=" + url + "}";
    }
}
