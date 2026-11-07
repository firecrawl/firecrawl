package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * Structured menu information extracted by the {@code menu} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Menu {

    @JsonProperty("isMenu")
    private boolean isMenu;
    private double confidence;
    private String currency;
    private String sourceUrl;
    private MenuMerchant merchant;
    private List<MenuSection> sections;

    @JsonProperty("isMenu")
    public boolean isMenu() { return isMenu; }
    public double getConfidence() { return confidence; }
    public String getCurrency() { return currency; }
    public String getSourceUrl() { return sourceUrl; }
    public MenuMerchant getMerchant() { return merchant; }
    public List<MenuSection> getSections() { return sections; }

    @Override
    public String toString() {
        return "Menu{isMenu=" + isMenu + ", sourceUrl=" + sourceUrl + "}";
    }
}
