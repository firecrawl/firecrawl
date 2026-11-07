package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A price associated with a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductPrice {

    private double amount;
    private String currency;
    private String formatted;

    public double getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public String getFormatted() { return formatted; }

    @Override
    public String toString() {
        return "ProductPrice{formatted=" + formatted + "}";
    }
}
