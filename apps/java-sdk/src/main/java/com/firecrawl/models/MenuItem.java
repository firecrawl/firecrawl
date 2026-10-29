package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * An item on a menu extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MenuItem {

    private String id;
    private String name;
    private String description;
    private List<MenuImage> images;
    private MenuPrice price;
    private MenuAvailability availability;
    private List<String> dietary;
    private Double calories;
    private List<Object> optionGroups;
    private MenuItemIdentifiers identifiers;
    private String url;
    private String sourceUrl;

    public String getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public List<MenuImage> getImages() { return images; }
    public MenuPrice getPrice() { return price; }
    public MenuAvailability getAvailability() { return availability; }
    public List<String> getDietary() { return dietary; }
    public Double getCalories() { return calories; }
    public List<Object> getOptionGroups() { return optionGroups; }
    public MenuItemIdentifiers getIdentifiers() { return identifiers; }
    public String getUrl() { return url; }
    public String getSourceUrl() { return sourceUrl; }

    @Override
    public String toString() {
        return "MenuItem{id=" + id + ", name=" + name + "}";
    }
}
