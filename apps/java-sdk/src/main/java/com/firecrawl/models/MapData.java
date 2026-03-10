package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Result of a map operation containing discovered URLs.
 *
 * <p>The v2 API may return {@code links} as either plain URL strings or
 * objects with {@code url}, {@code title}, and {@code description} fields.
 * This class normalises both representations into a uniform
 * {@code List<Map<String, Object>>} where each entry always contains at
 * least a {@code "url"} key.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MapData {

    private List<Object> links;

    /**
     * Returns the discovered links, normalised so that every entry is a
     * {@code Map<String, Object>} containing at least a {@code "url"} key.
     * Plain-string entries returned by the API are wrapped as
     * {@code {"url": "<value>"}}.
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getLinks() {
        if (links == null) {
            return null;
        }
        List<Map<String, Object>> result = new ArrayList<>(links.size());
        for (Object item : links) {
            if (item instanceof Map) {
                result.add((Map<String, Object>) item);
            } else if (item instanceof String) {
                Map<String, Object> wrapped = new LinkedHashMap<>();
                wrapped.put("url", item);
                result.add(wrapped);
            }
        }
        return Collections.unmodifiableList(result);
    }

    @Override
    public String toString() {
        int count = links != null ? links.size() : 0;
        return "MapData{links=" + count + "}";
    }
}
