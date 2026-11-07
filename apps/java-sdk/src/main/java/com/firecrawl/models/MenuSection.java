package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * A section of a menu extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuSection {

    private String id;
    private String name;
    private String description;
    private List<MenuItem> items;

    public String getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public List<MenuItem> getItems() { return items; }

    @Override
    public String toString() {
        return "MenuSection{id=" + id + ", name=" + name + "}";
    }
}
