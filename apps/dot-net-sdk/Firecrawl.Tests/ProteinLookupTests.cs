using System.Net;
using System.Text;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class ProteinLookupTests
{
    private const string ResponseBody =
        "{\"success\":true,\"release\":\"2026_04\",\"match\":\"found\",\"protein\":{"
        + "\"accession\":\"Q6P087\",\"entryName\":\"RUSD3_HUMAN\",\"gene\":\"RPUSD3\",\"synonyms\":[],"
        + "\"name\":\"Mitochondrial mRNA pseudouridine synthase RPUSD3\","
        + "\"organism\":{\"taxonId\":9606,\"scientificName\":\"Homo sapiens\",\"commonName\":\"Human\"},"
        + "\"matchedBy\":\"gene\",\"url\":\"https://www.uniprot.org/uniprotkb/Q6P087/entry\","
        + "\"subcellularLocation\":[{\"text\":\"Mitochondrion matrix\",\"note\":false,"
        + "\"evidence\":[{\"kind\":\"experimental\",\"eco\":\"ECO:0000269\",\"paperId\":\"pmid:27974379\"}]}],"
        + "\"function\":[],"
        + "\"goCellularComponent\":[{\"id\":\"GO:0005759\",\"term\":\"mitochondrial matrix\",\"code\":\"IDA\","
        + "\"assignedBy\":\"FlyBase\",\"paperIds\":[\"pmid:27974379\"]}],"
        + "\"paperIds\":[\"pmid:27974379\"]},"
        + "\"notice\":\"Protein data from UniProtKB/Swiss-Prot release 2026_04.\"}";

    private sealed class StubHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(ResponseBody, Encoding.UTF8, "application/json"),
            });
        }
    }

    [Fact]
    public async Task LookupProteinAsync_SendsProteinAndOrganism()
    {
        var handler = new StubHandler();
        var client = new FirecrawlClient(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));

        var response = await client.LookupProteinAsync("RPUSD3", new LookupProteinOptions { Organism = "Homo sapiens" });

        Assert.Equal(HttpMethod.Get, handler.Request!.Method);
        var uri = handler.Request.RequestUri!;
        Assert.Equal("/v2/search/research/proteins", uri.AbsolutePath);
        Assert.Contains("protein=RPUSD3", uri.Query);
        Assert.Contains("organism=Homo%20sapiens", uri.Query);
        Assert.Contains("origin=dotnet-sdk%40", uri.Query);

        Assert.Equal("found", response.Match);
        Assert.Equal(9606, response.Protein!.Organism!.TaxonId);
        Assert.Equal("pmid:27974379", response.Protein.SubcellularLocation![0].Evidence![0].PaperId);
        Assert.Equal("FlyBase", response.Protein.GoCellularComponent![0].AssignedBy);
    }
}
