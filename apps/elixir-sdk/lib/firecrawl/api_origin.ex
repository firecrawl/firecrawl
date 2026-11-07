defmodule Firecrawl.ApiOrigin do
  @moduledoc false

  @doc """
  Rewrites an absolute or protocol-relative `url` onto `api_url`'s scheme, host,
  and port so credentials never leave it, keeping the path and query and
  dropping the fragment.

  Relative URLs are returned unchanged. Raises `ArgumentError` if `api_url` is
  not an absolute URL.
  """
  @spec pin(String.t(), String.t() | URI.t()) :: String.t()
  def pin(url, api_url) do
    case URI.parse(url) do
      %URI{scheme: nil, host: nil} ->
        url

      parsed ->
        base = if is_binary(api_url) or is_struct(api_url, URI), do: URI.parse(api_url)

        case base do
          %URI{scheme: scheme, host: host} = base
          when is_binary(scheme) and host not in [nil, ""] ->
            URI.to_string(%URI{
              base
              | path: parsed.path || "/",
                query: parsed.query,
                fragment: nil
            })

          _ ->
            raise ArgumentError, "api_url must be an absolute URL, got: #{inspect(api_url)}"
        end
    end
  end
end
