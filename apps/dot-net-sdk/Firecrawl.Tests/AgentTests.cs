using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Exceptions;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class AgentTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Queue<string> _bodies;

        public StubHandler(params string[] bodies) => _bodies = new Queue<string>(bodies);

        public List<HttpRequestMessage> Requests { get; } = new();

        public List<string?> RequestBodies { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            RequestBodies.Add(request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_bodies.Dequeue(), Encoding.UTF8, "application/json"),
            };
        }
    }

    private static FirecrawlClient ClientFor(StubHandler handler) =>
        new(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));

    [Fact]
    public async Task StartAgentAsync_PostsPromptAndOptions()
    {
        var handler = new StubHandler("{\"success\":true,\"id\":\"agent-1\",\"threadId\":\"thread-1\",\"threadTurn\":1}");
        var client = ClientFor(handler);

        var response = await client.StartAgentAsync("Find the pricing plans", new AgentOptions
        {
            Urls = new List<string> { "https://example.com" },
            Schema = new Dictionary<string, object>
            {
                ["type"] = "object",
                ["properties"] = new Dictionary<string, object>
                {
                    ["plans"] = new Dictionary<string, object> { ["type"] = "array" },
                },
            },
            Model = "spark-2",
            Effort = "high",
            MaxCredits = 500,
            Location = new AgentLocation { Country = "DE" },
            Exchange = new Dictionary<string, object> { ["requireApproval"] = true },
        });

        Assert.True(response.Success);
        Assert.Equal("agent-1", response.Id);
        Assert.Equal("thread-1", response.ThreadId);
        Assert.Equal(1, response.ThreadTurn);

        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("http://localhost/v2/agent", request.RequestUri!.ToString());
        using var body = JsonDocument.Parse(handler.RequestBodies[0]!);
        var root = body.RootElement;
        Assert.Equal("Find the pricing plans", root.GetProperty("prompt").GetString());
        Assert.Equal("https://example.com", root.GetProperty("urls")[0].GetString());
        Assert.Equal("object", root.GetProperty("schema").GetProperty("type").GetString());
        Assert.Equal("spark-2", root.GetProperty("model").GetString());
        Assert.Equal("high", root.GetProperty("effort").GetString());
        Assert.Equal(500, root.GetProperty("maxCredits").GetInt32());
        Assert.Equal("DE", root.GetProperty("location").GetProperty("country").GetString());
        Assert.True(root.GetProperty("exchange").GetProperty("requireApproval").GetBoolean());
        Assert.StartsWith("dotnet-sdk@", root.GetProperty("origin").GetString());
        Assert.False(root.TryGetProperty("threadId", out _));
        Assert.False(root.TryGetProperty("webhook", out _));
        Assert.False(root.TryGetProperty("threatProtection", out _));
    }

    [Fact]
    public async Task GetAgentStatusAsync_ReadsPendingApproval()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"status\":\"processing\",\"pendingApproval\":{\"kind\":\"calls\",\"approvalId\":\"approval-1\"},\"exchange\":{\"calls\":1}}");
        var client = ClientFor(handler);

        var status = await client.GetAgentStatusAsync("agent-1");

        Assert.False(status.IsDone);
        var pending = Assert.IsType<JsonElement>(status.PendingApproval);
        Assert.Equal("approval-1", pending.GetProperty("approvalId").GetString());
        Assert.IsType<JsonElement>(status.Exchange);
        Assert.Null(status.Suggestions);
    }

    [Fact]
    public async Task StartAgentAsync_RequiresPrompt()
    {
        var client = ClientFor(new StubHandler());

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => client.StartAgentAsync(null!));
    }

    [Fact]
    public async Task GetAgentStatusAsync_ReadsCompletedJob()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"status\":\"completed\",\"data\":{\"plans\":[\"Free\",\"Pro\"]},\"model\":\"spark-2\",\"effort\":\"low\",\"expiresAt\":\"2026-10-20T00:00:00.000Z\",\"creditsUsed\":42,\"threadId\":\"thread-1\",\"threadTurn\":2,\"mode\":\"extract\"}");
        var client = ClientFor(handler);

        var status = await client.GetAgentStatusAsync("agent/1");

        Assert.True(status.IsDone);
        Assert.Equal("completed", status.Status);
        Assert.Equal("spark-2", status.Model);
        Assert.Equal("low", status.Effort);
        Assert.Equal(42, status.CreditsUsed);
        Assert.Equal(2, status.ThreadTurn);
        Assert.Equal("extract", status.Mode);
        var data = Assert.IsType<JsonElement>(status.Data);
        Assert.Equal("Pro", data.GetProperty("plans")[1].GetString());

        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("http://localhost/v2/agent/agent%2F1", request.RequestUri!.AbsoluteUri);
    }

    [Fact]
    public async Task AgentAsync_PollsUntilCompleted()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"id\":\"agent-1\"}",
            "{\"success\":true,\"status\":\"processing\"}",
            "{\"success\":true,\"status\":\"completed\",\"message\":\"Done\"}");
        var client = ClientFor(handler);

        var status = await client.AgentAsync("Summarize the page", pollIntervalSec: 0);

        Assert.Equal("completed", status.Status);
        Assert.Equal("Done", status.Message);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal(HttpMethod.Post, handler.Requests[0].Method);
        Assert.All(handler.Requests.Skip(1), request =>
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal("http://localhost/v2/agent/agent-1", request.RequestUri!.ToString());
        });
    }

    [Fact]
    public async Task AgentAsync_ReturnsFailedJobWithPartial()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"id\":\"agent-1\"}",
            "{\"success\":true,\"status\":\"failed\",\"error\":\"Credit limit reached\",\"partial\":{\"plans\":[\"Free\"]},\"partialSchemaValid\":false,\"stopReason\":\"credit_limit_reached\"}");
        var client = ClientFor(handler);

        var status = await client.AgentAsync("Summarize the page", pollIntervalSec: 0);

        Assert.Equal("failed", status.Status);
        Assert.Equal("Credit limit reached", status.Error);
        Assert.Equal("credit_limit_reached", status.StopReason);
        Assert.False(status.PartialSchemaValid);
        Assert.Null(status.Data);
        Assert.IsType<JsonElement>(status.Partial);
    }

    [Fact]
    public async Task AgentAsync_ThrowsWhenStartReturnsNoId()
    {
        var handler = new StubHandler("{\"success\":false,\"error\":\"Agent beta is not enabled\"}");
        var client = ClientFor(handler);

        var ex = await Assert.ThrowsAsync<FirecrawlException>(
            () => client.AgentAsync("Summarize the page"));

        Assert.Equal("Agent beta is not enabled", ex.Message);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task AgentAsync_ThrowsJobTimeoutException()
    {
        var handler = new StubHandler("{\"success\":true,\"id\":\"agent-1\"}");
        var client = ClientFor(handler);

        var ex = await Assert.ThrowsAsync<JobTimeoutException>(
            () => client.AgentAsync("Summarize the page", timeoutSec: 0));

        Assert.Equal("agent-1", ex.JobId);
        Assert.Equal(0, ex.TimeoutSeconds);
    }

    [Fact]
    public async Task CancelAgentAsync_SendsDelete()
    {
        var handler = new StubHandler("{\"success\":true}");
        var client = ClientFor(handler);

        var response = await client.CancelAgentAsync("agent-1");

        Assert.True(response.ContainsKey("success"));
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Delete, request.Method);
        Assert.Equal("http://localhost/v2/agent/agent-1", request.RequestUri!.ToString());
    }
}
