package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.Document;
import com.firecrawl.models.PdfParser;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class PdfPageMarkdownTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serializesPdfPageMarkdown() throws Exception {
        ScrapeOptions options = ScrapeOptions.builder()
                .parsers(List.<Object>of(PdfParser.builder()
                        .mode("auto")
                        .maxPages(5)
                        .pageMarkdown(true)
                        .build()))
                .build();

        JsonNode parser = mapper.valueToTree(options).get("parsers").get(0);
        assertEquals("pdf", parser.get("type").asText());
        assertEquals("auto", parser.get("mode").asText());
        assertEquals(5, parser.get("maxPages").asInt());
        assertEquals(true, parser.get("pageMarkdown").asBoolean());
    }

    @Test
    void deserializesPdfPages() throws Exception {
        Document document = mapper.readValue(
                "{\"pages\":[{\"pageNumber\":1,\"markdown\":\"# First\"},{\"pageNumber\":2,\"markdown\":\"# Second\"}]}",
                Document.class);

        assertEquals(2, document.getPages().size());
        assertEquals(2, document.getPages().get(1).getPageNumber());
        assertEquals("# Second", document.getPages().get(1).getMarkdown());
    }
}
