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
     * Returns {@code true} unless the product is known to be out of stock, so unknown stock
     * ({@code inStock} is {@code null}) reads as {@code true}, as older API responses reported it.
     *
     * @deprecated use {@link #getInStock()} for the tri-state value, which distinguishes unknown
     * stock ({@code null}) from in stock and out of stock.
     */
    @Deprecated
    @JsonIgnore
    public boolean isInStock() { return !Boolean.FALSE.equals(inStock); }

    public String getText() { return text; }

    @Override
    public String toString() {
        return "ProductAvailability{inStock=" + inStock + ", text=" + text + "}";
    }
}
