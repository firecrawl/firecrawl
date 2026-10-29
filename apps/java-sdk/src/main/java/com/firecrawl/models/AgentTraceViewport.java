package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Viewport dimensions of an agent browser session.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceViewport {

    private int width;
    private int height;

    public int getWidth() { return width; }
    public int getHeight() { return height; }

    @Override
    public String toString() {
        return "AgentTraceViewport{width=" + width + ", height=" + height + "}";
    }
}
