package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * The merchant a menu belongs to, extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuMerchant {

    private String name;
    private String type;
    private Object location;

    public String getName() { return name; }
    public String getType() { return type; }
    public Object getLocation() { return location; }

    @Override
    public String toString() {
        return "MenuMerchant{name=" + name + "}";
    }
}
