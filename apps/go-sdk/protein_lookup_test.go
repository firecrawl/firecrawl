package firecrawl

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestLookupProteinSendsProteinAndOrganism(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"release":"2026_04","match":"found","protein":{"accession":"Q6P087","entryName":"RUSD3_HUMAN","gene":"RPUSD3","synonyms":[],"name":"Mitochondrial mRNA pseudouridine synthase RPUSD3","organism":{"taxonId":9606,"scientificName":"Homo sapiens","commonName":"Human"},"matchedBy":"gene","url":"https://www.uniprot.org/uniprotkb/Q6P087/entry","subcellularLocation":[{"text":"Mitochondrion matrix","note":false,"evidence":[{"kind":"experimental","eco":"ECO:0000269","paperId":"pmid:27974379"}]}],"function":[],"goCellularComponent":[{"id":"GO:0005759","term":"mitochondrial matrix","code":"IDA","assignedBy":"FlyBase","paperIds":["pmid:27974379"]}],"paperIds":["pmid:27974379"]},"notice":"Protein data from UniProtKB/Swiss-Prot release 2026_04."}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	resp, err := client.LookupProtein(context.Background(), "RPUSD3", &LookupProteinOptions{Organism: "Homo sapiens"})
	if err != nil {
		t.Fatalf("LookupProtein: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/search/research/proteins" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	query, err := url.ParseQuery(req.query)
	if err != nil {
		t.Fatalf("ParseQuery: %v", err)
	}
	if query.Get("protein") != "RPUSD3" || query.Get("organism") != "Homo sapiens" || query.Get("origin") != "go-sdk@"+Version {
		t.Errorf("unexpected query: %s", req.query)
	}
	if resp.Match != "found" || resp.Protein == nil || resp.Protein.Organism.TaxonID != 9606 {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if got := resp.Protein.SubcellularLocation[0].Evidence[0].PaperID; got != "pmid:27974379" {
		t.Errorf("evidence paperId = %q", got)
	}
	if got := resp.Protein.GoCellularComponent[0].AssignedBy; got != "FlyBase" {
		t.Errorf("GO term assignedBy = %q", got)
	}
}
