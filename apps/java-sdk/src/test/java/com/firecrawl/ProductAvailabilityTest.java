package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.Document;
import com.firecrawl.models.ProductAvailability;
import com.firecrawl.models.ProductVariant;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ProductAvailabilityTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private ProductAvailability parse(String availabilityJson) throws Exception {
        String json = "{\"product\":{\"isProduct\":true,\"name\":\"Widget\",\"variants\":[{"
                + "\"name\":\"Default\",\"availability\":" + availabilityJson + "}]}}";
        Document doc = mapper.readValue(json, Document.class);
        return doc.getProduct().getVariants().get(0).getAvailability();
    }

    @Test
    @SuppressWarnings("deprecation")
    void inStockTrue() throws Exception {
        ProductAvailability availability = parse("{\"inStock\":true,\"text\":\"In stock\"}");
        assertEquals(Boolean.TRUE, availability.getInStock());
        assertTrue(availability.isInStock());
        assertEquals("In stock", availability.getText());
    }

    @Test
    @SuppressWarnings("deprecation")
    void inStockFalse() throws Exception {
        ProductAvailability availability = parse("{\"inStock\":false,\"text\":\"Sold out\"}");
        assertEquals(Boolean.FALSE, availability.getInStock());
        assertFalse(availability.isInStock());
    }

    @Test
    @SuppressWarnings("deprecation")
    void inStockNull() throws Exception {
        ProductAvailability availability = parse("{\"inStock\":null,\"text\":null}");
        assertNull(availability.getInStock());
        assertTrue(availability.isInStock());
    }

    @Test
    @SuppressWarnings("deprecation")
    void inStockMissing() throws Exception {
        ProductAvailability availability = parse("{\"text\":\"Call for availability\"}");
        assertNull(availability.getInStock());
        assertTrue(availability.isInStock());
        assertEquals("Call for availability", availability.getText());
    }

    @Test
    void serializesInStockOnce() throws Exception {
        JsonNode node = mapper.valueToTree(parse("{\"inStock\":false,\"text\":\"Sold out\"}"));
        assertEquals(2, node.size());
        assertFalse(node.get("inStock").asBoolean(true));
        assertEquals("Sold out", node.get("text").asText());

        JsonNode unknown = mapper.valueToTree(parse("{\"inStock\":null}"));
        assertTrue(unknown.has("inStock"));
        assertTrue(unknown.get("inStock").isNull());
    }

    @Test
    void roundTrips() throws Exception {
        ProductAvailability original = parse("{\"inStock\":null,\"text\":\"Unknown\"}");
        ProductAvailability copy = mapper.readValue(mapper.writeValueAsString(original), ProductAvailability.class);
        assertNull(copy.getInStock());
        assertEquals("Unknown", copy.getText());
    }

    @Test
    void variantIdentifiersRoundTrip() throws Exception {
        String fixture = "{\"sku\":\"SKU-1\",\"gtin\":\"00012345678905\",\"mpn\":\"MPN-1\","
                + "\"condition\":\"refurbished\",\"availability\":{\"inStock\":null}}";
        ProductVariant variant = mapper.readValue(fixture, ProductVariant.class);
        assertEquals("SKU-1", variant.getSku());
        assertEquals("00012345678905", variant.getGtin());
        assertEquals("MPN-1", variant.getMpn());
        assertEquals("refurbished", variant.getCondition());
        assertNull(variant.getAvailability().getInStock());

        JsonNode node = mapper.valueToTree(variant);
        assertEquals("00012345678905", node.get("gtin").asText());
        assertEquals("MPN-1", node.get("mpn").asText());
        assertEquals("refurbished", node.get("condition").asText());
        assertTrue(node.get("availability").get("inStock").isNull());
        ProductVariant copy = mapper.readValue(mapper.writeValueAsString(variant), ProductVariant.class);
        assertEquals("00012345678905", copy.getGtin());
        assertEquals("MPN-1", copy.getMpn());
        assertEquals("refurbished", copy.getCondition());
        assertNull(copy.getAvailability().getInStock());
    }

    @Test
    void variantOmitsAbsentIdentifiersAndKeepsUnknownCondition() throws Exception {
        JsonNode bare = mapper.valueToTree(mapper.readValue("{\"availability\":{\"inStock\":true}}", ProductVariant.class));
        assertFalse(bare.has("gtin"));
        assertFalse(bare.has("mpn"));
        assertFalse(bare.has("condition"));

        ProductVariant unknown = mapper.readValue("{\"condition\":\"open-box\"}", ProductVariant.class);
        assertEquals("open-box", unknown.getCondition());
    }

    @Test
    void toStringShowsUnknownStock() throws Exception {
        assertEquals("ProductAvailability{inStock=null, text=null}", parse("{}").toString());
    }
}
