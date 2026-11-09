package com.firecrawl.client;

import com.firecrawl.errors.FirecrawlException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ApiOriginTest {

    private static final String API = "https://api.firecrawl.dev";

    private static String pin(String apiUrl, String url) {
        return FirecrawlHttpClient.pinToApiOrigin(apiUrl, url).toString();
    }

    @Test
    void sameOriginUrlIsUnchanged() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "https://api.firecrawl.dev/v2/crawl/abc?skip=10"));
    }

    @Test
    void crossHostUrlIsRewrittenOntoApiOrigin() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "https://evil.example/v2/crawl/abc?skip=10"));
    }

    @Test
    void protocolRelativeUrlIsRewrittenOntoApiOrigin() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "//evil.example/v2/crawl/abc?skip=10"));
    }

    @Test
    void differentPortIsRewrittenOntoApiPort() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "https://api.firecrawl.dev:8443/v2/crawl/abc?skip=10"));
        assertEquals("http://localhost:3002/v2/crawl/abc?skip=10",
                pin("http://localhost:3002", "http://localhost:9999/v2/crawl/abc?skip=10"));
    }

    @Test
    void differentSchemeIsRewrittenOntoApiScheme() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "http://api.firecrawl.dev/v2/crawl/abc?skip=10"));
    }

    @Test
    void userInfoAndFragmentAreDropped() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "https://user:pass@evil.example/v2/crawl/abc?skip=10#frag"));
    }

    @Test
    void relativeUrlIsResolvedAgainstApiUrl() {
        assertEquals("https://api.firecrawl.dev/v2/crawl/abc?skip=10",
                pin(API, "/v2/crawl/abc?skip=10"));
    }

    @Test
    void pathRelativeUrlKeepsApiUrlPathPrefix() {
        assertEquals("https://api.example/prefix/next?skip=10",
                pin("https://api.example/prefix/", "next?skip=10"));
    }

    @Test
    void unresolvableUrlIsRejected() {
        assertThrows(FirecrawlException.class,
                () -> pin(API, "ftp://evil.example/v2/crawl/abc"));
    }

    @Test
    void nonAbsoluteApiUrlIsRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> pin("api.firecrawl.dev", "https://evil.example/v2/crawl/abc"));
    }
}
