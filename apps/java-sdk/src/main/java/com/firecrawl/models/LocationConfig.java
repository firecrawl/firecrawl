package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Geolocation configuration for requests.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class LocationConfig {

    private String country;
    private List<String> languages;

    private LocationConfig() {}

    public String getCountry() { return country; }
    public List<String> getLanguages() { return languages; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String country;
        private List<String> languages;

        private Builder() {}

        public Builder country(String country) { this.country = country; return this; }
        public Builder languages(List<String> languages) { this.languages = languages; return this; }

        public LocationConfig build() {
            LocationConfig c = new LocationConfig();
            c.country = this.country;
            c.languages = this.languages;
            return c;
        }
    }
}
