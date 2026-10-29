package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Availability information for a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductAvailability {

    private boolean inStock;
    private String text;

    public boolean isInStock() { return inStock; }
    public String getText() { return text; }

    @Override
    public String toString() {
        return "ProductAvailability{inStock=" + inStock + "}";
    }
}
