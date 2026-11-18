package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Availability information for a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductAvailability {

    @JsonProperty("inStock")
    private Boolean inStock;
    private String text;

    /**
     * Whether the product is in stock, or {@code null} when the page does not state it.
     */
    public Boolean getInStock() { return inStock; }

    /**
     * Returns {@code false} when stock is unknown ({@code inStock} is {@code null}).
     *
     * @deprecated use {@link #getInStock()}, which distinguishes unknown stock from out of stock.
     */
    @Deprecated
    @JsonIgnore
    public boolean isInStock() { return Boolean.TRUE.equals(inStock); }

    public String getText() { return text; }

    @Override
    public String toString() {
        return "ProductAvailability{inStock=" + inStock + ", text=" + text + "}";
    }
}
