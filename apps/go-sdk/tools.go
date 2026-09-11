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

// ExchangeExecutionError preserves the request ID for retrying the same payload.
type ExchangeExecutionError struct {
	RequestID string
	Err       error
}

func (e *ExchangeExecutionError) Error() string {
	return fmt.Sprintf("%v (request ID: %s)", e.Err, e.RequestID)
}
func (e *ExchangeExecutionError) Unwrap() error { return e.Err }

func (c *Client) ScrapeExchange(ctx context.Context, calls []ExchangeCall, opts *ExchangeOptions) (*ExchangeScrapeData, error) {
	if len(calls) == 0 {
		return nil, &FirecrawlError{Message: "at least one exchange call is required"}
	}
	if len(calls) > 10 {
		return nil, &FirecrawlError{Message: "at most 10 exchange calls are allowed per request"}
	}
	for i, call := range calls {
		if strings.TrimSpace(call.Provider) == "" {
			return nil, &FirecrawlError{Message: fmt.Sprintf("exchange call %d: provider is required", i)}
		}
		if strings.TrimSpace(call.Capability) == "" {
			return nil, &FirecrawlError{Message: fmt.Sprintf("exchange call %d: capability is required", i)}
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

	body := map[string]interface{}{"exchange": calls}
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
		return nil, &ExchangeExecutionError{RequestID: requestID, Err: err}
	}

	var envelope struct {
		ScrapeID string `json:"scrape_id"`
		Data     *struct {
			Exchange    []ExchangeScrapeResult `json:"exchange"`
			CreditsCost *int                   `json:"creditsCost"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, &ExchangeExecutionError{RequestID: requestID, Err: err}
	}
	if envelope.Data == nil || envelope.Data.Exchange == nil || envelope.Data.CreditsCost == nil || *envelope.Data.CreditsCost < 0 {
		return nil, &ExchangeExecutionError{RequestID: requestID, Err: &FirecrawlError{Message: "invalid exchange response"}}
	}
	return &ExchangeScrapeData{
		RequestID:   requestID,
		ScrapeID:    envelope.ScrapeID,
		Exchange:    envelope.Data.Exchange,
		CreditsCost: *envelope.Data.CreditsCost,
	}, nil
}

// FindTools explores the catalogue without executing the tools it returns.
func (c *Client) FindTools(ctx context.Context, opts *FindToolsOptions) (*FindToolsData, error) {
	options := map[string]interface{}{}
	mergeOptions(options, opts)
	result, err := c.ScrapeExchange(ctx, []ExchangeCall{{Provider: "firecrawl-contextual-discovery", Capability: "discovery/context", Options: options}}, nil)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*FindToolsData, error) {
		return nil, &ExchangeExecutionError{RequestID: result.RequestID, Err: err}
	}
	if len(result.Exchange) != 1 {
		return fail(&FirecrawlError{Message: "missing Find Tools result"})
	}
	item := result.Exchange[0]
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
