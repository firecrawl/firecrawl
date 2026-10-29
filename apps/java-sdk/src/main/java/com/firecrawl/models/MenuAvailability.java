package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Availability information for a menu item extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuAvailability {

    private boolean inStock;
    private String text;

    public boolean isInStock() { return inStock; }
    public String getText() { return text; }

    @Override
    public String toString() {
        return "MenuAvailability{inStock=" + inStock + "}";
    }
}
