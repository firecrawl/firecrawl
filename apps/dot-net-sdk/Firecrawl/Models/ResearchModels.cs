using System.Text.Json;
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

    [JsonPropertyName("createdDate")]
    public string? CreatedDate { get; set; }

    [JsonPropertyName("updateDate")]
    public string? UpdateDate { get; set; }

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

/// <summary>
/// <see cref="Match"/> is "found" with <see cref="Protein"/> set, "ambiguous" with
/// <see cref="Candidates"/> and <see cref="CandidateCount"/> set, or "not_found".
/// </summary>
public class ProteinLookupResponse
{
    public bool Success { get; set; }
    public string? Release { get; set; }
    public string? Match { get; set; }
    public ProteinEntry? Protein { get; set; }
    public List<ProteinCandidate>? Candidates { get; set; }
    public int? CandidateCount { get; set; }
    public string? Notice { get; set; }
}

public class ProteinEntry
{
    public string? Accession { get; set; }
    public string? EntryName { get; set; }
    public string? Gene { get; set; }
    public List<string>? Synonyms { get; set; }
    public string? Name { get; set; }
    public ProteinOrganism? Organism { get; set; }
    public string? MatchedBy { get; set; }
    public string? Url { get; set; }
    public List<ProteinStatement>? SubcellularLocation { get; set; }
    public List<ProteinStatement>? Function { get; set; }
    public List<GoTerm>? GoCellularComponent { get; set; }
    public List<string>? PaperIds { get; set; }
}

public class ProteinCandidate
{
    public string? Accession { get; set; }
    public string? EntryName { get; set; }
    public string? Gene { get; set; }
    public string? Name { get; set; }
    public ProteinOrganism? Organism { get; set; }
    public string? MatchedBy { get; set; }
}

public class ProteinOrganism
{
    public int TaxonId { get; set; }
    public string? ScientificName { get; set; }
    public string? CommonName { get; set; }
}

public class ProteinStatement
{
    public string? Text { get; set; }
    public bool Note { get; set; }
    public string? Molecule { get; set; }
    public string? Topology { get; set; }
    public string? Orientation { get; set; }
    public List<ProteinEvidence>? Evidence { get; set; }
}

/// <summary>
/// <see cref="PaperId"/> is a "pmid:" paper ID that <c>InspectPaperAsync</c> and
/// <c>ReadPaperAsync</c> accept.
/// </summary>
public class ProteinEvidence
{
    public string? Kind { get; set; }
    public string? Eco { get; set; }
    public string? PaperId { get; set; }
    public string? FromProtein { get; set; }
}

public class GoTerm
{
    public string? Id { get; set; }
    public string? Term { get; set; }
    public string? Code { get; set; }
    public string? AssignedBy { get; set; }
    public List<string>? PaperIds { get; set; }
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

public class DeveloperSearchPassage
{
    public string? Text { get; set; }

    [JsonPropertyName("citation_url")]
    public string? CitationUrl { get; set; }
}

/// <summary>
/// One ranked developer search result. <see cref="License"/> is either an SPDX
/// string or a disclosure object, so it is kept as raw JSON.
/// </summary>
public class DeveloperSearchResult
{
    public string? Id { get; set; }
    public string? Url { get; set; }
    public string? Title { get; set; }
    public List<DeveloperSearchPassage>? Passages { get; set; }
    public JsonElement? License { get; set; }
}

public class DeveloperSearchRepoTypes
{
    public bool Issue { get; set; }
    public bool PullRequest { get; set; }
    public bool Readme { get; set; }
}

public class DeveloperSearchRepoStatus
{
    public string? Repo { get; set; }
    public bool Indexed { get; set; }
    public DeveloperSearchRepoTypes? Types { get; set; }
}

public class DeveloperSearchSourceStatus
{
    public string? Source { get; set; }
    public bool Indexed { get; set; }
}

/// <summary>
/// Response from <c>DeveloperSearchAsync</c>. <see cref="Repos"/> and
/// <see cref="Sources"/> are set only when those filters were requested.
/// </summary>
public class DeveloperSearchResponse
{
    public bool Success { get; set; }
    public bool Partial { get; set; }
    public List<DeveloperSearchResult>? Results { get; set; }
    public List<DeveloperSearchRepoStatus>? Repos { get; set; }
    public List<DeveloperSearchSourceStatus>? Sources { get; set; }
}

public class SearchPapersOptions
{
    public int? K { get; set; }
    public List<string>? Authors { get; set; }
    public List<string>? Categories { get; set; }
    public string? From { get; set; }
    public string? To { get; set; }

    /// <summary>
    /// "relevance" is the default. "date_desc" returns the newest of the most relevant
    /// matches, newest first by created date. It does not list every paper in a date
    /// range. Set <see cref="From"/> and optionally <see cref="To"/> to filter dates.
    /// </summary>
    public string? Sort { get; set; }
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

public class LookupProteinOptions
{
    /// <summary>NCBI taxon ID, scientific name or UniProt common name (default "9606").</summary>
    public string? Organism { get; set; }
}

public class SearchGitHubOptions
{
    public int? K { get; set; }
}

public class DeveloperSearchOptions
{
    /// <summary>Total ranked results, 1 to 100 (default 10).</summary>
    public int? K { get; set; }

    /// <summary>Passages per result, 1 to 5 (default 1).</summary>
    public int? Passages { get; set; }

    /// <summary>Result kinds: "doc", "issue", "pull_request", "readme" (default all).</summary>
    public List<string>? Types { get; set; }

    /// <summary>GitHub owner/name filters, at most 20.</summary>
    public List<string>? Repos { get; set; }

    /// <summary>Developer documentation source IDs, at most 20.</summary>
    public List<string>? Sources { get; set; }

    /// <summary>One case-insensitive GitHub Linguist primary language.</summary>
    public string? Language { get; set; }

    /// <summary>Repository topics that must all match, at most 8.</summary>
    public List<string>? Topic { get; set; }

    /// <summary>One case-insensitive SPDX repository license identifier.</summary>
    public string? License { get; set; }

    [JsonPropertyName("min_stars")]
    public long? MinStars { get; set; }

    [JsonPropertyName("max_stars")]
    public long? MaxStars { get; set; }

    public bool? Archived { get; set; }
    public bool? Fork { get; set; }

    /// <summary>"only" returns packaged agent-skill evidence only.</summary>
    public string? Skills { get; set; }
}
