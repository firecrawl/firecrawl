package firecrawl

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// AlexandriaExecutionError preserves the request ID for retrying the same payload.
type AlexandriaExecutionError struct {
	RequestID string
	Err       error
}

func (e *AlexandriaExecutionError) Error() string {
	return fmt.Sprintf("%v (request ID: %s)", e.Err, e.RequestID)
}
func (e *AlexandriaExecutionError) Unwrap() error { return e.Err }

func (c *Client) ScrapeAlexandria(ctx context.Context, calls []AlexandriaCall, opts *AlexandriaOptions) (*AlexandriaScrapeData, error) {
	if len(calls) == 0 {
		return nil, &FirecrawlError{Message: "at least one alexandria call is required"}
	}
	if len(calls) > 10 {
		return nil, &FirecrawlError{Message: "at most 10 alexandria calls are allowed per request"}
	}
	for i, call := range calls {
		if strings.TrimSpace(call.Provider) == "" {
			return nil, &FirecrawlError{Message: fmt.Sprintf("alexandria call %d: provider is required", i)}
		}
		if strings.TrimSpace(call.Capability) == "" {
			return nil, &FirecrawlError{Message: fmt.Sprintf("alexandria call %d: capability is required", i)}
		}
	}
	if opts != nil && opts.Timeout != nil {
		if *opts.Timeout <= 0 {
			return nil, &FirecrawlError{Message: "timeout must be positive"}
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*opts.Timeout+5000)*time.Millisecond)
		defer cancel()
	}

	body := map[string]interface{}{"alexandria": calls}
	mergeOptions(body, opts)

	if _, ok := body["origin"]; !ok {
		body["origin"] = "go-sdk@" + Version
	}
	requestID := ""
	if opts != nil {
		requestID = opts.RequestID
	}
	if requestID == "" {
		var bytes [16]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return nil, err
		}
		requestID = hex.EncodeToString(bytes[:])
	}
	if !regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`).MatchString(requestID) {
		return nil, &FirecrawlError{Message: "invalid request ID"}
	}
	raw, err := c.http.post(ctx, "/v2/scrape", body, map[string]string{"x-request-id": requestID})
	if err != nil {
		return nil, &AlexandriaExecutionError{RequestID: requestID, Err: err}
	}

	var envelope struct {
		ScrapeID string `json:"scrape_id"`
		Data     *struct {
			Alexandria  []AlexandriaScrapeResult `json:"alexandria"`
			CreditsCost *int                     `json:"creditsCost"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, &AlexandriaExecutionError{RequestID: requestID, Err: err}
	}
	if envelope.Data == nil || envelope.Data.Alexandria == nil || envelope.Data.CreditsCost == nil || *envelope.Data.CreditsCost < 0 {
		return nil, &AlexandriaExecutionError{RequestID: requestID, Err: &FirecrawlError{Message: "invalid alexandria response"}}
	}
	return &AlexandriaScrapeData{
		RequestID:   requestID,
		ScrapeID:    envelope.ScrapeID,
		Alexandria:  envelope.Data.Alexandria,
		CreditsCost: *envelope.Data.CreditsCost,
	}, nil
}

// FindTools explores the catalogue without executing the tools it returns.
func (c *Client) FindTools(ctx context.Context, opts *FindToolsOptions) (*FindToolsData, error) {
	options := map[string]interface{}{}
	mergeOptions(options, opts)
	result, err := c.ScrapeAlexandria(ctx, []AlexandriaCall{{Provider: "firecrawl", Capability: "find-tools", Options: options}}, nil)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*FindToolsData, error) {
		return nil, &AlexandriaExecutionError{RequestID: result.RequestID, Err: err}
	}
	if len(result.Alexandria) != 1 {
		return fail(&FirecrawlError{Message: "missing Find Tools result"})
	}
	item := result.Alexandria[0]
	if item.Error != nil {
		return fail(&FirecrawlError{ErrorCode: item.Error.Code, Message: item.Error.Message})
	}
	raw, err := json.Marshal(item.Data)
	if err != nil {
		return fail(err)
	}
	var data FindToolsData
	if err := json.Unmarshal(raw, &data); err != nil {
		return fail(err)
	}
	return &data, nil
}
