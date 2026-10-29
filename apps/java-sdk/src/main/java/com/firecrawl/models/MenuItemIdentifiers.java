package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Identifiers for a menu item extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuItemIdentifiers {

    private String merchantItemId;

    public String getMerchantItemId() { return merchantItemId; }

    @Override
    public String toString() {
        return "MenuItemIdentifiers{merchantItemId=" + merchantItemId + "}";
    }
}
