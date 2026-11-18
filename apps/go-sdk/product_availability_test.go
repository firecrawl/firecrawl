package firecrawl

import (
	"encoding/json"
	"reflect"
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

func TestProductVariantIdentifiersRoundTrip(t *testing.T) {
	fixture := `{"sku":"SKU-1","gtin":"00012345678905","mpn":"MPN-1","condition":"refurbished","availability":{"inStock":null}}`
	var variant ProductVariant
	if err := json.Unmarshal([]byte(fixture), &variant); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if variant.GTIN != "00012345678905" || variant.MPN != "MPN-1" || variant.Condition != "refurbished" {
		t.Errorf("identifiers = %q %q %q", variant.GTIN, variant.MPN, variant.Condition)
	}
	if variant.Availability.InStock != nil {
		t.Errorf("inStock = %v, want nil", *variant.Availability.InStock)
	}

	out, err := json.Marshal(variant)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got, want map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("Unmarshal output: %v", err)
	}
	if err := json.Unmarshal([]byte(fixture), &want); err != nil {
		t.Fatalf("Unmarshal fixture: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("round trip = %s, want %s", out, fixture)
	}
}

func TestProductVariantOmitsAbsentIdentifiers(t *testing.T) {
	out, err := json.Marshal(ProductVariant{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, key := range []string{"gtin", "mpn", "condition"} {
		if strings.Contains(string(out), `"`+key+`"`) {
			t.Errorf("marshaled = %s, want no %s", out, key)
		}
	}

	var unknown ProductVariant
	if err := json.Unmarshal([]byte(`{"condition":"open-box","availability":{"inStock":false}}`), &unknown); err != nil {
		t.Fatalf("Unmarshal unknown condition: %v", err)
	}
	if unknown.Condition != "open-box" {
		t.Errorf("condition = %q, want open-box", unknown.Condition)
	}
}
