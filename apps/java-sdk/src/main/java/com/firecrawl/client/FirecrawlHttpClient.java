package com.firecrawl.client;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jdk8.Jdk8Module;
import com.firecrawl.errors.AuthenticationException;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.errors.RateLimitException;
import okhttp3.*;

import java.io.IOException;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Internal HTTP client for making authenticated requests to the Firecrawl API.
 * Handles retry logic with exponential backoff.
 */
class FirecrawlHttpClient {

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient httpClient;
    private final String apiKey;
    private final String baseUrl;
    private final int maxRetries;
    private final double backoffFactor;
    final ObjectMapper objectMapper;

    FirecrawlHttpClient(String apiKey, String baseUrl, long timeoutMs, int maxRetries, double backoffFactor) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.maxRetries = maxRetries;
        this.backoffFactor = backoffFactor;

        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build();

        this.objectMapper = new ObjectMapper()
                .registerModule(new Jdk8Module())
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    /**
     * Sends a POST request with JSON body.
     */
    <T> T post(String path, Object body, Class<T> responseType) {
        return post(path, body, responseType, Collections.emptyMap());
    }

    /**
     * Sends a POST request with JSON body and extra headers.
     */
    <T> T post(String path, Object body, Class<T> responseType, Map<String, String> extraHeaders) {
        String url = baseUrl + path;
        String json;
        try {
            json = objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new FirecrawlException("Failed to serialize request body", e);
        }
        RequestBody requestBody = RequestBody.create(json, JSON);
        Request.Builder builder = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .post(requestBody);
        for (Map.Entry<String, String> entry : extraHeaders.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        Request request = builder.build();
        return executeWithRetry(request, responseType);
    }

    /**
     * Sends a GET request.
     */
    <T> T get(String path, Class<T> responseType) {
        String url = baseUrl + path;
        Request request = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + apiKey)
                .get()
                .build();
        return executeWithRetry(request, responseType);
    }

    /**
     * Sends a GET request with full URL (for following next-page cursors).
     */
    <T> T getAbsolute(String absoluteUrl, Class<T> responseType) {
        Request request = new Request.Builder()
                .url(absoluteUrl)
                .header("Authorization", "Bearer " + apiKey)
                .get()
                .build();
        return executeWithRetry(request, responseType);
    }

    /**
     * Sends a DELETE request.
     */
    <T> T delete(String path, Class<T> responseType) {
        String url = baseUrl + path;
        Request request = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + apiKey)
                .delete()
                .build();
        return executeWithRetry(request, responseType);
    }

    /**
     * Sends a raw GET request and returns the response body as a parsed Map.
     */
    @SuppressWarnings("unchecked")
    Map<String, Object> getRaw(String path) {
        return get(path, Map.class);
    }

    private <T> T executeWithRetry(Request request, Class<T> responseType) {
        int attempt = 0;
        while (true) {
            try {
                try (Response response = httpClient.newCall(request).execute()) {
                    ResponseBody responseBody = response.body();
                    String bodyStr = responseBody != null ? responseBody.string() : "";

                    if (response.isSuccessful()) {
                        if (responseType == Void.class || responseType == void.class) {
                            return null;
                        }
                        return objectMapper.readValue(bodyStr, responseType);
                    }

                    int code = response.code();

                    // Parse error details from response
                    String errorMessage = extractErrorMessage(bodyStr, code);
                    String errorCode = extractErrorCode(bodyStr);

                    // Non-retryable client errors
                    if (code == 401) {
                        throw new AuthenticationException(errorMessage, errorCode, null);
                    }
                    if (code == 429) {
                        throw new RateLimitException(errorMessage, errorCode, null);
                    }
                    if (code >= 400 && code < 500 && code != 408 && code != 409) {
                        throw new FirecrawlException(errorMessage, code, errorCode, null);
                    }

                    // Retryable errors: 408, 409, 502, 5xx
                    if (attempt < maxRetries) {
                        attempt++;
                        sleepWithBackoff(attempt);
                        continue;
                    }

                    throw new FirecrawlException(errorMessage, code, errorCode, null);
                }
            } catch (FirecrawlException e) {
                throw e;
            } catch (IOException e) {
                if (attempt < maxRetries) {
                    attempt++;
                    sleepWithBackoff(attempt);
                    continue;
                }
                throw new FirecrawlException("Request failed: " + e.getMessage(), e);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private String extractErrorMessage(String body, int statusCode) {
        try {
            Map<String, Object> parsed = objectMapper.readValue(body, Map.class);
            if (parsed.containsKey("error")) {
                return String.valueOf(parsed.get("error"));
            }
            if (parsed.containsKey("message")) {
                return String.valueOf(parsed.get("message"));
            }
        } catch (Exception ignored) {
        }
        return "HTTP " + statusCode + " error";
    }

    @SuppressWarnings("unchecked")
    private String extractErrorCode(String body) {
        try {
            Map<String, Object> parsed = objectMapper.readValue(body, Map.class);
            Object code = parsed.get("code");
            return code != null ? String.valueOf(code) : null;
        } catch (Exception ignored) {
        }
        return null;
    }

    private void sleepWithBackoff(int attempt) {
        long delayMs = (long) (backoffFactor * 1000 * Math.pow(2, attempt - 1));
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new FirecrawlException("Request interrupted during retry backoff", e);
        }
    }
}
