package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Options for parsing uploaded files via /v2/parse.
 *
     * <p>Parse does not support browser-rendering formats/options such as
     * change tracking, screenshot, branding, product, menu, audio, video, actions, waitFor, location, or mobile.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ParseOptions {

    private List<Object> formats;
    private Map<String, String> headers;
    private List<String> includeTags;
    private List<String> excludeTags;
    private Boolean onlyMainContent;
    private Integer timeout;
    private List<Object> parsers;
    private Boolean skipTlsVerification;
    private Boolean removeBase64Images;
    private Boolean blockAds;
    private String proxy;
    private String integration;
    @JsonProperty("redactPII")
    private Boolean redactPII;

    private ParseOptions() {}

    public List<Object> getFormats() { return formats; }
    public Map<String, String> getHeaders() { return headers; }
    public List<String> getIncludeTags() { return includeTags; }
    public List<String> getExcludeTags() { return excludeTags; }
    public Boolean getOnlyMainContent() { return onlyMainContent; }
    public Integer getTimeout() { return timeout; }
    public List<Object> getParsers() { return parsers; }
    public Boolean getSkipTlsVerification() { return skipTlsVerification; }
    public Boolean getRemoveBase64Images() { return removeBase64Images; }
    public Boolean getBlockAds() { return blockAds; }
    public String getProxy() { return proxy; }
    public String getIntegration() { return integration; }
    @JsonProperty("redactPII")
    public Boolean getRedactPII() { return redactPII; }

    public static Builder builder() { return new Builder(); }

    public Builder toBuilder() {
        Builder b = new Builder();
        b.formats = this.formats != null ? new ArrayList<>(this.formats) : null;
        b.headers = this.headers != null ? new HashMap<>(this.headers) : null;
        b.includeTags = this.includeTags != null ? new ArrayList<>(this.includeTags) : null;
        b.excludeTags = this.excludeTags != null ? new ArrayList<>(this.excludeTags) : null;
        b.onlyMainContent = this.onlyMainContent;
        b.timeout = this.timeout;
        b.parsers = this.parsers != null ? new ArrayList<>(this.parsers) : null;
        b.skipTlsVerification = this.skipTlsVerification;
        b.removeBase64Images = this.removeBase64Images;
        b.blockAds = this.blockAds;
        b.proxy = this.proxy;
        b.integration = this.integration;
        b.redactPII = this.redactPII;
        return b;
    }

    private static String extractFormatType(Object fmt) {
        if (fmt instanceof String) return (String) fmt;
        if (fmt instanceof Map<?, ?>) {
            Map<?, ?> mapObj = (Map<?, ?>) fmt;
            Object type = mapObj.get("type");
            if (type instanceof String) return (String) type;
        }
        try {
            Object type = fmt.getClass().getMethod("getType").invoke(fmt);
            if (type instanceof String) return (String) type;
        } catch (ReflectiveOperationException ignored) {
            // Ignore: format object doesn't expose a getType() method.
        }
        return null;
    }

    private static boolean isUnsupportedParseFormat(String formatType) {
        if (formatType == null) return false;
        String normalized = formatType.trim();
        return normalized.equals("changeTracking")
                || normalized.equals("change_tracking")
                || normalized.equals("screenshot")
                || normalized.equals("screenshot@fullPage")
                || normalized.equals("branding")
                || normalized.equals("product")
                || normalized.equals("menu")
                || normalized.equals("audio")
                || normalized.equals("video");
    }

    public static final class Builder {
        private List<Object> formats;
        private Map<String, String> headers;
        private List<String> includeTags;
        private List<String> excludeTags;
        private Boolean onlyMainContent;
        private Integer timeout;
        private List<Object> parsers;
        private Boolean skipTlsVerification;
        private Boolean removeBase64Images;
        private Boolean blockAds;
        private String proxy;
        private String integration;
        private Boolean redactPII;

        private Builder() {}

        public Builder formats(List<Object> formats) { this.formats = formats; return this; }
        public Builder headers(Map<String, String> headers) { this.headers = headers; return this; }
        public Builder includeTags(List<String> includeTags) { this.includeTags = includeTags; return this; }
        public Builder excludeTags(List<String> excludeTags) { this.excludeTags = excludeTags; return this; }
        public Builder onlyMainContent(Boolean onlyMainContent) { this.onlyMainContent = onlyMainContent; return this; }
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }
        public Builder parsers(List<Object> parsers) { this.parsers = parsers; return this; }
        public Builder skipTlsVerification(Boolean skipTlsVerification) { this.skipTlsVerification = skipTlsVerification; return this; }
        public Builder removeBase64Images(Boolean removeBase64Images) { this.removeBase64Images = removeBase64Images; return this; }
        public Builder blockAds(Boolean blockAds) { this.blockAds = blockAds; return this; }
        public Builder proxy(String proxy) { this.proxy = proxy; return this; }
        public Builder integration(String integration) { this.integration = integration; return this; }
        public Builder redactPII(Boolean redactPII) { this.redactPII = redactPII; return this; }

        public ParseOptions build() {
            if (timeout != null && timeout <= 0) {
                throw new IllegalArgumentException("timeout must be positive");
            }
            if (proxy != null && !proxy.isBlank()) {
                if (!proxy.equals("basic") && !proxy.equals("auto")) {
                    throw new IllegalArgumentException("parse only supports proxy values 'basic' or 'auto'");
                }
            }
            if (formats != null) {
                for (Object fmt : formats) {
                    String formatType = extractFormatType(fmt);
                    if (isUnsupportedParseFormat(formatType)) {
                        throw new IllegalArgumentException("parse does not support format: " + formatType);
                    }
                }
            }

            ParseOptions o = new ParseOptions();
            o.formats = this.formats != null ? Collections.unmodifiableList(new ArrayList<>(this.formats)) : null;
            o.headers = this.headers != null ? Collections.unmodifiableMap(new HashMap<>(this.headers)) : null;
            o.includeTags = this.includeTags != null ? Collections.unmodifiableList(new ArrayList<>(this.includeTags)) : null;
            o.excludeTags = this.excludeTags != null ? Collections.unmodifiableList(new ArrayList<>(this.excludeTags)) : null;
            o.onlyMainContent = this.onlyMainContent;
            o.timeout = this.timeout;
            o.parsers = this.parsers != null ? Collections.unmodifiableList(new ArrayList<>(this.parsers)) : null;
            o.skipTlsVerification = this.skipTlsVerification;
            o.removeBase64Images = this.removeBase64Images;
            o.blockAds = this.blockAds;
            o.proxy = this.proxy;
            o.integration = this.integration;
            o.redactPII = this.redactPII;
            return o;
        }
    }
}
