package firecrawl

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductAvailabilityInStock(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name         string
		availability string
		want         *bool
	}{
		{"true", `{"inStock": true, "text": "In stock"}`, &yes},
		{"false", `{"inStock": false, "text": "Sold out"}`, &no},
		{"null", `{"inStock": null}`, nil},
		{"missing", `{"text": "Call for availability"}`, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(`{"product": {"isProduct": true, "variants": [{"title": "Default", "availability": ` + tc.availability + `}]}}`)
			var doc Document
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if doc.Product == nil || len(doc.Product.Variants) != 1 {
				t.Fatalf("expected one variant, got %+v", doc.Product)
			}
			got := doc.Product.Variants[0].Availability.InStock
			switch {
			case tc.want == nil && got != nil:
				t.Errorf("inStock = %v, want nil", *got)
			case tc.want != nil && got == nil:
				t.Errorf("inStock = nil, want %v", *tc.want)
			case tc.want != nil && *got != *tc.want:
				t.Errorf("inStock = %v, want %v", *got, *tc.want)
			}
		})
	}
}

func TestProductAvailabilityMarshalsUnknownAsNull(t *testing.T) {
	out, err := json.Marshal(ProductAvailability{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(out), `"inStock":null`) {
		t.Errorf("marshaled = %s, want inStock null", out)
	}
}
