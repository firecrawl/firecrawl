package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;

/**
 * User attribution included with SIEM logging events.
 */
public final class AuditMetadata {
    private final String username;

    public AuditMetadata(String username) {
        this.username = Objects.requireNonNull(username, "username");
    }

    @JsonProperty("username")
    public String getUsername() {
        return username;
    }
}
