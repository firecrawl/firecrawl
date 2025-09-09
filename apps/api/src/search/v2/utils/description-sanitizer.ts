/**
 * Utility functions
 */

/**
 * Detects if a description appears to be Google's "Missing:" format
 */
export function isGoogleMissingDescription(description: string): boolean {
    if (!description) return false;

    if (description.startsWith("Missing:")) {
        return true;
    }

    const suspiciousPatterns = [
        /^Missing:/i,
        /Missing:.*optionally/i,
        /Missing:.*wikipedia/i,
        /Missing:.*google/i,
        /Missing:.*personal.*webpage/i
    ];

    return suspiciousPatterns.some(pattern => pattern.test(description));
}

/**
 * Attempts to generate a fallback description when Google's description is unusual
 */
export function generateFallbackDescription(url: string, title: string): string {
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.replace('www.', '');

        if (title && title !== domain) {
            return `${title} - Information from ${domain}`;
        } else {
            return `Content from ${domain}`;
        }
    } catch {
        return title || "Search result";
    }
}

/**
 * Sanitizes a search result description, replacing unusual ones with fallbacks
 */
export function sanitizeDescription(description: string, url: string, title: string): string {
    if (!description) {
        return generateFallbackDescription(url, title);
    }

    if (isGoogleMissingDescription(description)) {
        return generateFallbackDescription(url, title);
    }

    return description;
}
