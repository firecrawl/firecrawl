package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

/**
 * A variant of a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductVariant {

    private String id;
    private String sku;
    private String title;
    private Map<String, Object> values;
    private ProductPrice price;
    private ProductSale sale;
    private ProductAvailability availability;
    private List<ProductImage> images;

    public String getId() { return id; }
    public String getSku() { return sku; }
    public String getTitle() { return title; }
    public Map<String, Object> getValues() { return values; }
    public ProductPrice getPrice() { return price; }
    public ProductSale getSale() { return sale; }
    public ProductAvailability getAvailability() { return availability; }
    public List<ProductImage> getImages() { return images; }

    @Override
    public String toString() {
        return "ProductVariant{id=" + id + ", title=" + title + "}";
    }
}
