defmodule Firecrawl.Error do
  @moduledoc """
  Exception raised when the Firecrawl API returns an error response (HTTP 4xx/5xx).

  ## Fields

    * `:status` - The HTTP status code
    * `:body` - The decoded response body (typically a map with `"error"` key)
  """

  defexception [:status, :body]

  @type t :: %__MODULE__{
          status: pos_integer(),
          body: term()
        }

  @impl true
  def message(%__MODULE__{status: status, body: body}) when is_map(body) do
    error_msg =
      case body["error"] || body["message"] do
        msg when is_binary(msg) -> msg
        _ -> inspect(body)
      end

    "Firecrawl API error (HTTP #{status}): #{error_msg}"
  end

  def message(%__MODULE__{status: status, body: body}) do
    "Firecrawl API error (HTTP #{status}): #{inspect(body)}"
  end
end
