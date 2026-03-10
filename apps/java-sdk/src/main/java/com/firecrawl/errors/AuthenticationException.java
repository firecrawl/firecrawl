package com.firecrawl.errors;

/**
 * Thrown when the API returns a 401 Unauthorized response.
 */
public class AuthenticationException extends FirecrawlException {

    public AuthenticationException(String message) {
        super(message, 401);
    }

    public AuthenticationException(String message, String errorCode, Object details) {
        super(message, 401, errorCode, details);
    }
}
