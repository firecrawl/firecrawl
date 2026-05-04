package firecrawl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

const (
	defaultAPIURL        = "https://api.firecrawl.dev"
	defaultTimeout       = 5 * time.Minute
	defaultMaxRetries    = 3
	defaultBackoffFactor = 0.5
)

// httpClient is the internal HTTP client for the Firecrawl API.
type httpClient struct {
	client        *http.Client
	apiKey        string
	baseURL       string
	maxRetries    int
	backoffFactor float64
	extraHeaders  map[string]string
}

func newHTTPClient(apiKey, baseURL string, client *http.Client, maxRetries int, backoffFactor float64, extraHeaders map[string]string) *httpClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &httpClient{
		client:        client,
		apiKey:        apiKey,
		baseURL:       baseURL,
		maxRetries:    maxRetries,
		backoffFactor: backoffFactor,
		extraHeaders:  extraHeaders,
	}
}

// post sends a POST request with a JSON body.
func (h *httpClient) post(ctx context.Context, path string, body interface{}, extraHeaders map[string]string) (json.RawMessage, error) {
	url := h.baseURL + path
	return h.doJSON(ctx, "POST", url, body, extraHeaders)
}

// patch sends a PATCH request.
func (h *httpClient) patch(ctx context.Context, path string, body interface{}) (json.RawMessage, error) {
	url := h.baseURL + path
	return h.doJSON(ctx, "PATCH", url, body, nil)
}

// get sends a GET request.
func (h *httpClient) get(ctx context.Context, path string) (json.RawMessage, error) {
	url := h.baseURL + path
	return h.doJSON(ctx, "GET", url, nil, nil)
}

// getAbsolute sends a GET request to an absolute URL (for pagination cursors).
func (h *httpClient) getAbsolute(ctx context.Context, absoluteURL string) (json.RawMessage, error) {
	return h.doJSON(ctx, "GET", absoluteURL, nil, nil)
}

// delete sends a DELETE request.
func (h *httpClient) delete(ctx context.Context, path string) (json.RawMessage, error) {
	url := h.baseURL + path
	return h.doJSON(ctx, "DELETE", url, nil, nil)
}

// postMultipart sends a POST request with a multipart/form-data body. The extra
// text `fields` are written first, followed by a single file part.
func (h *httpClient) postMultipart(
	ctx context.Context,
	path string,
	fields map[string]string,
	fileField, fileName, fileContentType string,
	fileContent []byte,
) (json.RawMessage, error) {
	url := h.baseURL + path

	buildBody := func() (io.Reader, string, error) {
		buf := &bytes.Buffer{}
		writer := multipart.NewWriter(buf)

		for k, v := range fields {
			if err := writer.WriteField(k, v); err != nil {
				return nil, "", err
			}
		}

		partHeader := make(textproto.MIMEHeader)
		partHeader.Set(
			"Content-Disposition",
			fmt.Sprintf(`form-data; name=%q; filename=%q`, fileField, fileName),
		)
		if fileContentType != "" {
			partHeader.Set("Content-Type", fileContentType)
		}
		part, err := writer.CreatePart(partHeader)
		if err != nil {
			return nil, "", err
		}
		if _, err := part.Write(fileContent); err != nil {
			return nil, "", err
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return buf, writer.FormDataContentType(), nil
	}

	body, contentType, err := buildBody()
	if err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to build multipart body: %v", err)}
	}

	var lastErr error
	for attempt := 0; attempt <= h.maxRetries; attempt++ {
		if attempt > 0 {
			if err := h.sleepBackoff(ctx, attempt); err != nil {
				return nil, err
			}
			body, contentType, err = buildBody()
			if err != nil {
				return nil, &FirecrawlError{Message: fmt.Sprintf("failed to rebuild multipart body: %v", err)}
			}
		}

		req, err := http.NewRequestWithContext(ctx, "POST", url, body)
		if err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to create request: %v", err)}
		}

		req.Header.Set("Authorization", "Bearer "+h.apiKey)
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("User-Agent", "firecrawl-go/"+Version)
		for k, v := range h.extraHeaders {
			req.Header.Set(k, v)
		}

		resp, err := h.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			continue
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return json.RawMessage(respBody), nil
		}

		errMsg, errCode := extractError(respBody, resp.StatusCode)

		switch resp.StatusCode {
		case 401:
			return nil, &AuthenticationError{
				FirecrawlError: FirecrawlError{StatusCode: 401, ErrorCode: errCode, Message: errMsg},
			}
		case 429:
			return nil, &RateLimitError{
				FirecrawlError: FirecrawlError{StatusCode: 429, ErrorCode: errCode, Message: errMsg},
			}
		}

		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 408 && resp.StatusCode != 409 {
			return nil, &FirecrawlError{StatusCode: resp.StatusCode, ErrorCode: errCode, Message: errMsg}
		}

		lastErr = &FirecrawlError{StatusCode: resp.StatusCode, ErrorCode: errCode, Message: errMsg}
	}

	if lastErr != nil {
		if fe, ok := lastErr.(*FirecrawlError); ok {
			return nil, fe
		}
		return nil, &FirecrawlError{Message: fmt.Sprintf("request failed after %d retries: %v", h.maxRetries, lastErr)}
	}
	return nil, &FirecrawlError{Message: "request failed"}
}

func (h *httpClient) doJSON(ctx context.Context, method, url string, body interface{}, extraHeaders map[string]string) (json.RawMessage, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to serialize request body: %v", err)}
		}
		bodyReader = bytes.NewReader(data)
	}

	var lastErr error
	for attempt := 0; attempt <= h.maxRetries; attempt++ {
		if attempt > 0 {
			if err := h.sleepBackoff(ctx, attempt); err != nil {
				return nil, err
			}

			// Reset the body reader for retries.
			if body != nil {
				data, _ := json.Marshal(body)
				bodyReader = bytes.NewReader(data)
			}
		}

		req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
		if err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to create request: %v", err)}
		}

		req.Header.Set("Authorization", "Bearer "+h.apiKey)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "firecrawl-go/"+Version)
		// Apply client-level headers.
		for k, v := range h.extraHeaders {
			req.Header.Set(k, v)
		}
		// Apply per-request headers (override client-level).
		for k, v := range extraHeaders {
			req.Header.Set(k, v)
		}

		resp, err := h.client.Do(req)
		if err != nil {
			// If context is cancelled, return immediately instead of retrying.
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			continue // Retry on transport errors.
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return json.RawMessage(respBody), nil
		}

		// Parse error details from the response.
		errMsg, errCode := extractError(respBody, resp.StatusCode)

		// Non-retryable client errors.
		switch resp.StatusCode {
		case 401:
			return nil, &AuthenticationError{
				FirecrawlError: FirecrawlError{StatusCode: 401, ErrorCode: errCode, Message: errMsg},
			}
		case 429:
			return nil, &RateLimitError{
				FirecrawlError: FirecrawlError{StatusCode: 429, ErrorCode: errCode, Message: errMsg},
			}
		}

		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 408 && resp.StatusCode != 409 {
			return nil, &FirecrawlError{StatusCode: resp.StatusCode, ErrorCode: errCode, Message: errMsg}
		}

		// Retryable: 408, 409, 5xx
		lastErr = &FirecrawlError{StatusCode: resp.StatusCode, ErrorCode: errCode, Message: errMsg}
	}

	if lastErr != nil {
		if fe, ok := lastErr.(*FirecrawlError); ok {
			return nil, fe
		}
		return nil, &FirecrawlError{Message: fmt.Sprintf("request failed after %d retries: %v", h.maxRetries, lastErr)}
	}
	return nil, &FirecrawlError{Message: "request failed"}
}

func (h *httpClient) sleepBackoff(ctx context.Context, attempt int) error {
	delay := time.Duration(h.backoffFactor*1000*math.Pow(2, float64(attempt-1))) * time.Millisecond
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(delay):
		return nil
	}
}

// extractError parses an API error response to get the message and error code.
func extractError(body []byte, statusCode int) (string, string) {
	var parsed map[string]interface{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Sprintf("HTTP %d error", statusCode), ""
	}

	msg := fmt.Sprintf("HTTP %d error", statusCode)
	if v, ok := parsed["error"]; ok {
		msg = fmt.Sprintf("%v", v)
	} else if v, ok := parsed["message"]; ok {
		msg = fmt.Sprintf("%v", v)
	}

	var errCode string
	if v, ok := parsed["code"]; ok && v != nil {
		errCode = fmt.Sprintf("%v", v)
	}

	return msg, errCode
}
