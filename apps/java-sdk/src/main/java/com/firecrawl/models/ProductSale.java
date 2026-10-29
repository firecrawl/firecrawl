package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Sale information for a product variant extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductSale {

    private ProductPrice originalPrice;

    public ProductPrice getOriginalPrice() { return originalPrice; }

    @Override
    public String toString() {
        return "ProductSale{originalPrice=" + originalPrice + "}";
    }
}
