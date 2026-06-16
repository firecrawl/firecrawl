using System.Text.Json.Serialization;

namespace Firecrawl.Models;

public class PaperResult
{
    [JsonPropertyName("paperId")]
    public string? PaperId { get; set; }

    [JsonPropertyName("primaryId")]
    public string? PrimaryId { get; set; }

    public Dictionary<string, object>? Ids { get; set; }
    public string? Title { get; set; }
    public string? Abstract { get; set; }
    public double? Score { get; set; }
    public int? Year { get; set; }
    public List<string>? Authors { get; set; }
    public string? Venue { get; set; }
    public string? Url { get; set; }
    public Dictionary<string, object>? Signals { get; set; }
}

public class PaperMetadata
{
    [JsonPropertyName("paperId")]
    public string? PaperId { get; set; }

    public Dictionary<string, object>? Ids { get; set; }
    public string? Title { get; set; }
    public string? Abstract { get; set; }
    public string? Authors { get; set; }
    public List<string>? Categories { get; set; }

    [JsonPropertyName("createdDate")]
    public string? CreatedDate { get; set; }

    [JsonPropertyName("updateDate")]
    public string? UpdateDate { get; set; }
}

public class Passage
{
    public string? Text { get; set; }
    public string? Section { get; set; }
    public int? Page { get; set; }
    public double? Score { get; set; }
    public Dictionary<string, object>? Metadata { get; set; }
}

public class SearchPapersResponse
{
    public bool Success { get; set; }
    public List<PaperResult>? Results { get; set; }
}

public class PaperMetadataResponse
{
    public bool Success { get; set; }
    public PaperMetadata? Paper { get; set; }
}

public class ReadPaperResponse
{
    public bool Success { get; set; }
    public PaperMetadata? Paper { get; set; }

    [JsonPropertyName("paperId")]
    public string? PaperId { get; set; }

    public string? Query { get; set; }
    public List<Passage>? Passages { get; set; }
}

public class SimilarPapersResponse
{
    public bool Success { get; set; }
    public List<PaperResult>? Results { get; set; }

    [JsonPropertyName("poolSize")]
    public int? PoolSize { get; set; }

    public bool Truncated { get; set; }
    public string? Note { get; set; }
}

public class GitHubSearchItem
{
    public string? ResultType { get; set; }

    public string? Repo { get; set; }
    public string? Url { get; set; }

    public string? PageType { get; set; }

    public int? Number { get; set; }

    public int? SegmentCount { get; set; }

    public string? ReadmeUrl { get; set; }

    public string? Title { get; set; }
    public string? Snippet { get; set; }

    public string? ContentMd { get; set; }

    public Dictionary<string, object>? Scores { get; set; }
}

public class GitHubSearchResponse
{
    public bool Success { get; set; }
    public List<GitHubSearchItem>? Results { get; set; }
}

public class SearchPapersOptions
{
    public int? K { get; set; }
    public List<string>? Authors { get; set; }
    public List<string>? Categories { get; set; }
    public string? From { get; set; }
    public string? To { get; set; }
}

public class ReadPaperOptions
{
    public int? K { get; set; }
}

public class RelatedPapersOptions
{
    public string? Mode { get; set; }
    public int? K { get; set; }
    public bool? Rerank { get; set; }
    public List<string>? Anchor { get; set; }
}

public class SearchGitHubOptions
{
    public int? K { get; set; }
}
