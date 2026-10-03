package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.Collections;
import java.util.List;

/**
 * An upload type accepted by {@code POST /v2/parse}, as returned by
 * {@code GET /v2/parse/formats}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ParseFormat {

    /**
     * Category of a parse format. Values the SDK does not know yet map to {@link #UNKNOWN};
     * the raw value stays available via {@link ParseFormat#getKind()}.
     */
    public enum Kind {
        DOCUMENT("document"),
        IMAGE("image"),
        UNKNOWN(null);

        private final String value;

        Kind(String value) {
            this.value = value;
        }

        public String getValue() {
            return value;
        }

        public static Kind fromValue(String value) {
            for (Kind kind : values()) {
                if (kind.value != null && kind.value.equals(value)) {
                    return kind;
                }
            }
            return UNKNOWN;
        }
    }

    private String format;
    private String kind;
    private List<String> extensions;
    private List<String> mimeTypes;
    private boolean available;

    /** Format identifier, e.g. {@code "pdf"} or {@code "png"}. */
    public String getFormat() { return format; }

    /** Raw kind value, e.g. {@code "document"} or {@code "image"}. */
    public String getKind() { return kind; }

    /** Kind as an enum; {@link Kind#UNKNOWN} for values this SDK version does not know. */
    @JsonIgnore
    public Kind getKindType() { return Kind.fromValue(kind); }

    /** File extensions including the leading dot, e.g. {@code ".pdf"}. */
    public List<String> getExtensions() { return extensions != null ? extensions : Collections.emptyList(); }

    /** Accepted MIME types, e.g. {@code "application/pdf"}. */
    public List<String> getMimeTypes() { return mimeTypes != null ? mimeTypes : Collections.emptyList(); }

    /** Whether this format can be parsed on the current deployment. */
    public boolean isAvailable() { return available; }

    @Override
    public String toString() {
        return "ParseFormat{format=" + format + ", kind=" + kind + ", available=" + available + "}";
    }
}
