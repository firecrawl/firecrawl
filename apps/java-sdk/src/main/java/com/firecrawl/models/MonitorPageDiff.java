package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Diff payload returned alongside a monitor page when its scrape
 * produced a change. The shape depends on what the monitor's formats
 * asked for:
 *
 * <ul>
 *   <li>Markdown-only monitors: {@code text} holds the unified diff
 *   and {@code json} holds the {@code parseDiff} AST (a
 *   {@code {"files": [...]}} object).</li>
 *   <li>JSON-extraction monitors: {@code json} holds the per-field
 *   map of {@link MonitorJsonFieldDiff} entries and {@code text} is
 *   absent.</li>
 *   <li>Mixed (JSON + git-diff) monitors: both fields are populated:
 *   {@code json} is the per-field diff map and {@code text} is the
 *   markdown sidecar.</li>
 * </ul>
 *
 * <p>{@code json} is exposed as {@link Object} because its concrete
 * shape depends on the monitor mode; callers should cast or re-deserialize
 * with Jackson into either a {@code Map<String, MonitorJsonFieldDiff>}
 * (JSON / mixed mode) or a {@code Map<String, Object>} containing the
 * {@code files} key (markdown mode).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorPageDiff {
    private String text;
    private Object json;

    public String getText() { return text; }
    public Object getJson() { return json; }
}
