defmodule Firecrawl.DeveloperSearch do
  @moduledoc """
  Response of `Firecrawl.search_developer/2`.

  ## Fields

    * `:success` - Whether the request succeeded
    * `:partial` - Whether some of the index could not be searched, so results may be incomplete
    * `:results` - Ranked `Firecrawl.DeveloperSearch.Result` structs
    * `:repos` - Index status per requested repository, or `nil` when `repos` was not sent
    * `:sources` - Index status per requested documentation source, or `nil` when `sources` was not sent
  """

  alias Firecrawl.DeveloperSearch.{Repo, Result, Source}

  defstruct [:success, :partial, :repos, :sources, results: []]

  @type t :: %__MODULE__{
          success: boolean(),
          partial: boolean(),
          results: [Result.t()],
          repos: [Repo.t()] | nil,
          sources: [Source.t()] | nil
        }

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    %__MODULE__{
      success: map["success"] == true,
      partial: map["partial"] == true,
      results: Enum.map(map["results"] || [], &Result.from_map/1),
      repos: map["repos"] && Enum.map(map["repos"], &Repo.from_map/1),
      sources: map["sources"] && Enum.map(map["sources"], &Source.from_map/1)
    }
  end
end

defmodule Firecrawl.DeveloperSearch.Result do
  @moduledoc """
  One ranked developer search result.

  `:license` is either an SPDX string or a disclosure map, so it is kept as
  returned. `:passages` are the matched passage texts, in markdown.
  """

  defstruct [:id, :url, :title, :license, passages: []]

  @type t :: %__MODULE__{
          id: String.t(),
          url: String.t(),
          title: String.t() | nil,
          license: String.t() | map() | nil,
          passages: [String.t()]
        }

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    %__MODULE__{
      id: map["id"],
      url: map["url"],
      title: map["title"],
      license: map["license"],
      passages: for(%{"text" => text} <- map["passages"] || [], do: text)
    }
  end
end

defmodule Firecrawl.DeveloperSearch.Repo do
  @moduledoc """
  Whether a requested repository is indexed.

  `:types` reports which result types are indexed for it, with the keys
  `:issue`, `:pull_request` and `:readme`.
  """

  defstruct [:repo, indexed: false, types: %{issue: false, pull_request: false, readme: false}]

  @type t :: %__MODULE__{
          repo: String.t(),
          indexed: boolean(),
          types: %{issue: boolean(), pull_request: boolean(), readme: boolean()}
        }

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    types = map["types"] || %{}

    %__MODULE__{
      repo: map["repo"],
      indexed: map["indexed"] == true,
      types: %{
        issue: types["issue"] == true,
        pull_request: types["pullRequest"] == true,
        readme: types["readme"] == true
      }
    }
  end
end

defmodule Firecrawl.DeveloperSearch.Source do
  @moduledoc "Whether a requested documentation source is indexed."

  defstruct [:source, indexed: false]

  @type t :: %__MODULE__{source: String.t(), indexed: boolean()}

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    %__MODULE__{source: map["source"], indexed: map["indexed"] == true}
  end
end
