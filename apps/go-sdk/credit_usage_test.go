package firecrawl

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestGetCreditUsageDecodesData(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want CreditUsage
	}{
		{"funded", `{"success":true,"data":{"remainingCredits":73,"planCredits":100,"billingPeriodStart":"2026-11-01","billingPeriodEnd":"2026-12-01"}}`, CreditUsage{RemainingCredits: 73, PlanCredits: 100, BillingPeriodStart: "2026-11-01", BillingPeriodEnd: "2026-12-01"}},
		{"zero balance", `{"success":true,"data":{"remainingCredits":0,"planCredits":100,"billingPeriodStart":null,"billingPeriodEnd":null}}`, CreditUsage{PlanCredits: 100}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v2/team/credit-usage" {
					http.NotFound(w, r)
					return
				}
				io.WriteString(w, tc.body)
			}))
			defer server.Close()
			client, err := NewClient(option.WithAPIURL(server.URL), option.WithAPIKey("fc-test"))
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.GetCreditUsage(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if *got != tc.want {
				t.Errorf("got %+v, want %+v", *got, tc.want)
			}
		})
	}
}

func TestGetCreditUsageRejectsInvalidData(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantMessage string
	}{
		{"missing data", `{"success":true}`, "missing credit usage data"},
		{"null data", `{"success":true,"data":null}`, "missing credit usage data"},
		{"invalid balance", `{"success":true,"data":{"remainingCredits":"invalid"}}`, "failed to decode data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, tc.body)
			}))
			defer server.Close()
			client, err := NewClient(option.WithAPIURL(server.URL), option.WithAPIKey("fc-test"))
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.GetCreditUsage(context.Background())
			var apiErr *FirecrawlError
			if got != nil || !errors.As(err, &apiErr) || !strings.Contains(apiErr.Message, tc.wantMessage) {
				t.Fatalf("got %+v, error %v; want nil usage and FirecrawlError containing %q", got, err, tc.wantMessage)
			}
		})
	}
}
