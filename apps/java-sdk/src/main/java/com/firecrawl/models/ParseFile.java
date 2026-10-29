package com.firecrawl.models;

import java.util.Arrays;
import java.util.Objects;

/**
 * Binary upload payload for the v2 parse endpoint.
 */
public class ParseFile {
    private final byte[] content;
    private final String filename;
    private final String contentType;

    private ParseFile(byte[] content, String filename, String contentType) {
        this.content = content;
        this.filename = filename;
        this.contentType = contentType;
    }

    public byte[] getContent() {
        return Arrays.copyOf(content, content.length);
    }

    public String getFilename() {
        return filename;
    }

    public String getContentType() {
        return contentType;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private byte[] content;
        private String filename;
        private String contentType;

        private Builder() {}

        /** Raw file content bytes. */
        public Builder content(byte[] content) {
            this.content = content != null ? Arrays.copyOf(content, content.length) : null;
            return this;
        }

        /** Uploaded filename (e.g., "document.pdf"). */
        public Builder filename(String filename) {
            this.filename = filename;
            return this;
        }

        /** Optional MIME type hint (e.g., "application/pdf"). */
        public Builder contentType(String contentType) {
            this.contentType = contentType;
            return this;
        }

        public ParseFile build() {
            Objects.requireNonNull(content, "File content is required");
            if (content.length == 0) {
                throw new IllegalArgumentException("File content cannot be empty");
            }
            Objects.requireNonNull(filename, "Filename is required");
            if (filename.isBlank()) {
                throw new IllegalArgumentException("Filename cannot be blank");
            }
            return new ParseFile(
                    Arrays.copyOf(content, content.length),
                    filename.trim(),
                    contentType
            );
        }
    }
}
