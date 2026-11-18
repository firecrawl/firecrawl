package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * A variant of a product extracted by the {@code product} scrape format.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ProductVariant {

    private String id;
    private String sku;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String gtin;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String mpn;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String condition;
    private String title;
    private Map<String, Object> values;
    private ProductPrice price;
    private ProductSale sale;
    private ProductAvailability availability;
    private List<ProductImage> images;

    public String getId() { return id; }
    public String getSku() { return sku; }

    /** Global Trade Item Number (UPC, EAN, ISBN), or {@code null} when absent. */
    public String getGtin() { return gtin; }

    /** Manufacturer part number, or {@code null} when absent. */
    public String getMpn() { return mpn; }

    /**
     * Item condition: {@code new}, {@code used}, {@code refurbished} or {@code damaged}, or {@code null}
     * when absent. A string so values added later still parse.
     */
    public String getCondition() { return condition; }

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
