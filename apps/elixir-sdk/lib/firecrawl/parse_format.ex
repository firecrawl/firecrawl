defmodule Firecrawl.ParseFormat do
  @moduledoc """
  A file format accepted by `Firecrawl.parse_file/3`, as returned by
  `Firecrawl.get_parse_formats/1`.

  ## Fields

    * `:format` - Format identifier, e.g. `"pdf"`
    * `:kind` - `:document` or `:image`; any other value the API sends is kept as a string
    * `:extensions` - File extensions, e.g. `[".pdf"]`
    * `:mime_types` - MIME types, e.g. `["application/pdf"]`
    * `:available` - Whether this deployment can parse the format right now
  """

  defstruct [:format, :kind, extensions: [], mime_types: [], available: false]

  @type kind :: :document | :image | String.t()

  @type t :: %__MODULE__{
          format: String.t(),
          kind: kind(),
          extensions: [String.t()],
          mime_types: [String.t()],
          available: boolean()
        }

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    %__MODULE__{
      format: map["format"] || "",
      kind: to_kind(map["kind"] || ""),
      extensions: map["extensions"] || [],
      mime_types: map["mimeTypes"] || [],
      available: map["available"] == true
    }
  end

  defp to_kind("document"), do: :document
  defp to_kind("image"), do: :image
  defp to_kind(other), do: other
end
