package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Structured product information extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Product {

    private String title;
    private String brand;
    private String category;
    private String url;
    private String description;
    private List<ProductImage> images;
    private ProductPrice price;
    private ProductPrice originalPrice;
    private ProductAvailability availability;
    private List<ProductVariant> variants;

    public String getTitle() { return title; }
    public String getBrand() { return brand; }
    public String getCategory() { return category; }
    public String getUrl() { return url; }
    public String getDescription() { return description; }
    public List<ProductImage> getImages() { return images; }
    public ProductPrice getPrice() { return price; }
    public ProductPrice getOriginalPrice() { return originalPrice; }
    public ProductAvailability getAvailability() { return availability; }
    public List<ProductVariant> getVariants() { return variants; }

    @Override
    public String toString() {
        return "Product{title=" + title + ", url=" + url + "}";
    }
}
