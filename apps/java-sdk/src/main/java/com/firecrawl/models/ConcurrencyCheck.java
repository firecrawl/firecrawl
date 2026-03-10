package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Current concurrency usage.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ConcurrencyCheck {

    private int concurrency;
    private int maxConcurrency;

    public int getConcurrency() { return concurrency; }
    public int getMaxConcurrency() { return maxConcurrency; }

    @Override
    public String toString() {
        return "ConcurrencyCheck{concurrency=" + concurrency + "/" + maxConcurrency + "}";
    }
}
