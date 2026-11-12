package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.ResearchModels;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class ProteinLookupMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> requestLine = new AtomicReference<>();
    private final AtomicReference<String> requestQuery = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requestLine.set(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            requestQuery.set(exchange.getRequestURI().getRawQuery());
            byte[] bytes = ("{\"success\":true,\"release\":\"2026_04\",\"match\":\"found\",\"protein\":{"
                    + "\"accession\":\"Q6P087\",\"entryName\":\"RUSD3_HUMAN\",\"gene\":\"RPUSD3\",\"synonyms\":[],"
                    + "\"name\":\"Mitochondrial mRNA pseudouridine synthase RPUSD3\","
                    + "\"organism\":{\"taxonId\":9606,\"scientificName\":\"Homo sapiens\",\"commonName\":\"Human\"},"
                    + "\"matchedBy\":\"gene\",\"url\":\"https://www.uniprot.org/uniprotkb/Q6P087/entry\","
                    + "\"subcellularLocation\":[{\"text\":\"Mitochondrion matrix\",\"note\":false,"
                    + "\"evidence\":[{\"kind\":\"experimental\",\"eco\":\"ECO:0000269\",\"paperId\":\"pmid:27974379\"}]}],"
                    + "\"function\":[],"
                    + "\"goCellularComponent\":[{\"id\":\"GO:0005759\",\"term\":\"mitochondrial matrix\",\"code\":\"IDA\","
                    + "\"assignedBy\":\"FlyBase\",\"paperIds\":[\"pmid:27974379\"]}],"
                    + "\"paperIds\":[\"pmid:27974379\"]},"
                    + "\"notice\":\"Protein data from UniProtKB/Swiss-Prot release 2026_04.\"}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();
        client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .apiUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .maxRetries(0)
                .build();
    }

    @AfterEach
    void teardown() {
        server.stop(0);
    }

    @Test
    void lookupProteinSendsProteinAndOrganism() {
        ResearchModels.LookupProteinOptions options = new ResearchModels.LookupProteinOptions();
        options.organism = "Homo sapiens";

        ResearchModels.ProteinLookupResponse response = client.lookupProtein("RPUSD3", options);

        assertEquals("GET /v2/search/research/proteins", requestLine.get());
        String query = requestQuery.get();
        assertTrue(query.contains("protein=RPUSD3"), query);
        assertTrue(query.contains("organism=Homo+sapiens"), query);

        assertEquals("found", response.match);
        assertEquals(9606, response.protein.organism.taxonId);
        assertEquals("pmid:27974379", response.protein.subcellularLocation.get(0).evidence.get(0).paperId);
        assertEquals("FlyBase", response.protein.goCellularComponent.get(0).assignedBy);
        assertNull(response.candidates);
    }
}
