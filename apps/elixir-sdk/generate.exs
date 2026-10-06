#!/usr/bin/env elixir
# generate.exs — Auto-generates the Firecrawl Elixir SDK from the OpenAPI spec.
#
# Usage:
#   mix run generate.exs                                    # fetch the latest spec
#   FIRECRAWL_OPENAPI_SPEC=openapi.json mix run generate.exs  # offline, from the vendored copy
#
# This script:
# 1. Fetches the Firecrawl v2 OpenAPI JSON spec
# 2. Parses all endpoints and generates Elixir wrapper functions with NimbleOptions validation
# 3. If the code changed, writes lib/firecrawl.ex (keeping its HAND-WRITTEN region
#    verbatim) and saves the spec it came from as openapi.json
# 4. Bumps the version in mix.exs if the generated code changed

defmodule Firecrawl.Generator do
  @openapi_url "https://raw.githubusercontent.com/firecrawl/firecrawl-docs/main/api-reference/v2-openapi.json"
  @output_file "lib/firecrawl.ex"
  @spec_file "openapi.json"
  @mix_file "mix.exs"

  # Operations to exclude from the generated client.
  @skip_operations MapSet.new([
    "extractData",
    "getExtractStatus",
    "getTokenUsage",
    "getHistoricalTokenUsage"
  ])

  # Routes implemented in the HAND-WRITTEN region of lib/firecrawl.ex, so a spec
  # entry for them never generates a second definition.
  @hand_written_routes MapSet.new([
    {"get", "/parse/formats"},
    {"get", "/agent/{jobId}/trace"},
    {"get", "/search/research/papers"},
    {"get", "/search/research/papers/{id}"},
    {"get", "/search/research/papers/{id}/similar"},
    {"get", "/search/research/github"},
    {"post", "/monitor"},
    {"get", "/monitor"},
    {"get", "/monitor/{monitorId}"},
    {"patch", "/monitor/{monitorId}"},
    {"delete", "/monitor/{monitorId}"},
    {"post", "/monitor/{monitorId}/run"},
    {"get", "/monitor/{monitorId}/checks"},
    {"get", "/monitor/{monitorId}/checks/{checkId}"}
  ])

  @hand_written_begin "  # --- BEGIN HAND-WRITTEN ---"
  @hand_written_end "  # --- END HAND-WRITTEN ---"

  # NimbleOptions types that deliberately differ from what the spec implies,
  # keyed by {function name, JSON property}.
  @type_overrides %{
    {"start_agent", "effort"} => ~S|{:in, ["low", "medium", "high"]}|
  }

  # The method key becomes the Req function name in generated code, a position
  # no escaping can protect, so anything else stops generation outright.
  @http_methods ~w(get post put patch delete head options)

  def run do
    IO.puts("Fetching OpenAPI spec...")
    {:ok, raw_spec} = fetch_spec()
    spec = Jason.decode!(raw_spec)

    old_code = File.read!(@output_file)

    IO.puts("Generating client code...")
    code = generate_module(spec, hand_written_region(old_code))

    if code != old_code do
      File.write!(@spec_file, raw_spec)
      File.write!(@output_file, code)
      IO.puts("Wrote #{@output_file}")

      bump_type = detect_bump_type(old_code, code)
      bump_version(bump_type)
    else
      IO.puts("No changes detected — skipping write and version bump.")
    end
  end

  defp fetch_spec do
    Application.ensure_all_started(:req)

    # Set FIRECRAWL_OPENAPI_SPEC to a local file to generate without the network.
    case System.get_env("FIRECRAWL_OPENAPI_SPEC") do
      nil -> fetch_remote_spec()
      path -> {:ok, File.read!(path)}
    end
  end

  # The body is kept raw so openapi.json stays byte-identical to the published spec.
  defp fetch_remote_spec do
    case Req.get(@openapi_url, decode_body: false) do
      {:ok, %Req.Response{status: 200, body: body}} when is_binary(body) ->
        {:ok, body}

      {:ok, %Req.Response{status: status}} ->
        {:error, "HTTP #{status}"}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ---------------------------------------------------------------------------
  # Module template
  # ---------------------------------------------------------------------------

  # Returns the HAND-WRITTEN region of `source`, markers included.
  def hand_written_region(source) do
    case String.split(source, [@hand_written_begin, @hand_written_end]) do
      [_before, inner, _after] -> @hand_written_begin <> inner <> @hand_written_end
      _ -> raise "#{@output_file} must contain exactly one HAND-WRITTEN region"
    end
  end

  def generate_module(spec, hand_written) do
    base_url =
      case get_in(spec, ["servers"]) do
        [%{"url" => url} | _] -> url
        _ -> "https://api.firecrawl.dev/v2"
      end

    api_version = get_in(spec, ["info", "version"]) || "v2"
    paths = Map.get(spec, "paths", %{})

    functions =
      paths
      |> Enum.flat_map(fn {path, methods} ->
        path_level_params = Map.get(methods, "parameters", [])

        methods
        |> Enum.reject(fn {key, _} -> key == "parameters" end)
        |> Enum.map(fn {method, operation} ->
          unless method in @http_methods do
            raise ArgumentError, "refusing unknown HTTP method #{inspect(method)} at #{inspect(path)}"
          end

          {method, path, operation, path_level_params}
        end)
      end)
      |> Enum.reject(fn {method, path, op, _} ->
        MapSet.member?(@skip_operations, Map.get(op, "operationId", "")) or
          MapSet.member?(@hand_written_routes, {method, path})
      end)
      |> Enum.sort_by(fn {_method, _path, op, _} -> Map.get(op, "operationId", "") end)
      |> Enum.map(&generate_function(&1, spec))
      |> Enum.join("\n")

    clashes =
      MapSet.intersection(extract_public_functions(functions), extract_public_functions(hand_written))

    if MapSet.size(clashes) > 0 do
      raise "generated functions clash with the HAND-WRITTEN region: " <>
              Enum.join(clashes, ", ") <> ". Add their routes to @hand_written_routes."
    end

    bt = <<96>>
    headers_line = ~S'    headers = if api_key, do: [{"authorization", "Bearer #{api_key}"}], else: []'

    """
    # This file is generated by generate.exs from openapi.json. Edit by hand only
    # inside the HAND-WRITTEN region, which regeneration keeps verbatim.
    # Re-generate with: mix run generate.exs

    defmodule Firecrawl do
      @moduledoc \"\"\"
      Auto-generated Firecrawl API #{escape_source_text(api_version)} client.

      Generated from the OpenAPI spec at:
      #{@openapi_url}

      ## Configuration

      Set your API key in application config:

          config :firecrawl, api_key: "fc-your-api-key"

      Or pass it as an option to any function:

          Firecrawl.scrape_and_extract_from_url([url: "https://example.com"], api_key: "fc-your-api-key")

      ## Options

      All functions accept an optional keyword list as the last argument with:

        * #{bt}:api_key#{bt} - Override the API key for this request
        * #{bt}:base_url#{bt} - Override the default API base URL (useful for self-hosted instances)
        * Any other options are passed through to the #{bt}Req#{bt} request

      ## Usage

          {:ok, response} = Firecrawl.scrape_and_extract_from_url(
            url: "https://example.com"
          )

          {:ok, response} = Firecrawl.crawl_urls(
            url: "https://example.com",
            limit: 100
          )
      \"\"\"

      @type response :: {:ok, Req.Response.t()} | {:error, Exception.t() | Firecrawl.Error.t()}

      @base_url #{inspect(base_url)}
      # Sourced from mix.exs at compile time so the origin header cannot drift
      # from the published package version.
      @version Mix.Project.config()[:version]
      @sdk_origin "elixir-sdk@" <> @version

      defp client(opts) do
        api_key =
          Keyword.get_lazy(opts, :api_key, fn ->
            Application.get_env(:firecrawl, :api_key)
          end)

        # A nil/empty key is allowed: scrape, search, and interact fall back to the
        # keyless free tier (rate-limited per IP). Other endpoints return 401 from the
        # API until a key is provided.
        api_key =
          case api_key do
            key when is_binary(key) ->
              case String.trim(key) do
                "" -> nil
                trimmed -> trimmed
              end

            _ ->
              nil
          end

        {base_url, opts} = Keyword.pop(opts, :base_url, @base_url)
        opts = Keyword.delete(opts, :api_key)

    #{headers_line}

        Req.new(
          base_url: base_url,
          headers: headers
        )
        |> Req.merge(opts)
        |> Req.Request.append_response_steps(firecrawl_error_handler: &handle_api_error/1)
      end

      defp handle_api_error({request, %Req.Response{status: status} = response}) when status >= 400 do
        {request, Firecrawl.Error.exception(status: status, body: response.body)}
      end

      defp handle_api_error({request, response}), do: {request, response}

      defp to_body(validated_params, key_mapping) do
        validated_params
        |> to_json_object(key_mapping)
        # Identify the SDK so the API can grant the keyless free tier; harmless
        # telemetry on keyed requests.
        |> Map.put_new("origin", @sdk_origin)
      end

      defp to_json_object(params, key_mapping) do
        Map.new(params, fn {k, v} ->
          case Map.fetch!(key_mapping, k) do
            {json_key, nested_mapping} -> {json_key, to_json_object(v, nested_mapping)}
            json_key -> {json_key, to_json_value(v)}
          end
        end)
      end

      defp to_query(validated_params, key_mapping) do
        Enum.map(validated_params, fn {k, v} ->
          {Map.fetch!(key_mapping, k), to_json_value(v)}
        end)
      end

      defp to_json_value(atom) when is_atom(atom) and atom not in [true, false, nil] do
        Atom.to_string(atom)
      end

      defp to_json_value(map) when is_map(map), do: map

      defp to_json_value(list) when is_list(list) do
        if Keyword.keyword?(list) and list != [] do
          Map.new(list, fn {k, v} -> {camelize(Atom.to_string(k)), to_json_value(v)} end)
        else
          Enum.map(list, &to_json_value/1)
        end
      end

      defp to_json_value(value), do: value

      defp camelize(string) do
        [first | rest] = String.split(string, "_")
        Enum.join([first | Enum.map(rest, &String.capitalize/1)])
      end

      defp fetch_file_field(file, key) do
        case Keyword.fetch(file, key) do
          {:ok, _value} = ok -> ok
          :error -> {:error, %ArgumentError{message: "missing required file field: \#{key}"}}
        end
      end

      defp validate_filename(filename) do
        if is_binary(filename) and filename != "" do
          :ok
        else
          {:error, %ArgumentError{message: "filename cannot be empty"}}
        end
      end

      defp validate_data(data) do
        if is_nil(data) do
          {:error, %ArgumentError{message: "file data cannot be empty"}}
        else
          :ok
        end
      end

    #{hand_written}

    #{functions}end
    """
  end

  # ---------------------------------------------------------------------------
  # Per-function generation
  # ---------------------------------------------------------------------------

  defp generate_function({method, path, operation, path_level_params}, spec) do
    operation_id = Map.get(operation, "operationId", "unknown")
    func_name = to_snake_case(operation_id)
    summary = Map.get(operation, "summary", "")
    tag = operation |> Map.get("tags", []) |> List.first() || ""

    op_params = Map.get(operation, "parameters", [])
    all_params = Enum.map(path_level_params ++ op_params, &resolve_if_ref(&1, spec))

    path_params =
      all_params
      |> Enum.filter(fn p -> Map.get(p, "in") == "path" end)
      |> Enum.map(fn p -> Map.get(p, "name") end)

    query_params =
      all_params
      |> Enum.filter(fn p -> Map.get(p, "in") == "query" end)

    has_body = Map.has_key?(operation, "requestBody")
    http_method = String.upcase(method)

    if has_body and multipart?(operation) do
      generate_multipart_function(method, path, operation, spec, func_name, summary, tag)
    else
      generate_json_function(
        method,
        path,
        operation,
        spec,
        func_name,
        summary,
        tag,
        path_params,
        query_params,
        has_body,
        http_method
      )
    end
  end

  defp generate_json_function(
         method,
         path,
         operation,
         spec,
         func_name,
         summary,
         tag,
         path_params,
         query_params,
         has_body,
         http_method
       ) do
    # Extract request body schema
    body_properties = if has_body, do: extract_body_properties(operation, spec), else: []
    required_keys = if has_body, do: extract_required_keys(operation, spec), else: []

    # Build schema/mapping for body params
    body_schema_code =
      if has_body, do: generate_schema(func_name, body_properties, required_keys), else: nil

    body_key_mapping_code =
      if has_body, do: generate_key_mapping(func_name, body_properties), else: nil

    # Build schema/mapping for query params
    has_query_schema = query_params != []

    query_schema_code =
      if has_query_schema, do: generate_query_schema(func_name, query_params), else: nil

    query_key_mapping_code =
      if has_query_schema, do: generate_query_key_mapping(func_name, query_params), else: nil

    query_param_names = Enum.map(query_params, fn p -> Map.get(p, "name") end)

    # Build docs
    doc =
      build_doc(
        summary,
        http_method,
        path,
        tag,
        path_params,
        query_param_names,
        has_body,
        func_name,
        has_query_schema
      )

    # Build non-bang and bang function bodies
    {sig, body} =
      build_function_body(
        func_name,
        method,
        path,
        path_params,
        query_param_names,
        has_body,
        has_query_schema,
        false
      )

    {bang_sig, bang_body} =
      build_function_body(
        func_name,
        method,
        path,
        path_params,
        query_param_names,
        has_body,
        has_query_schema,
        true
      )

    # Build typespecs
    deprecated_code = build_deprecated(operation)
    spec_code = build_typespec(func_name, path_params, has_body || has_query_schema, false)
    bang_spec_code = build_typespec(func_name, path_params, has_body || has_query_schema, true)

    parts = [
      body_schema_code,
      body_key_mapping_code,
      query_schema_code,
      query_key_mapping_code,
      doc,
      deprecated_code,
      spec_code,
      "  #{sig}",
      body,
      "",
      doc_bang(func_name),
      deprecated_code,
      bang_spec_code,
      "  #{bang_sig}",
      bang_body,
      ""
    ]

    parts |> Enum.reject(&is_nil/1) |> Enum.join("\n")
  end

  # ---------------------------------------------------------------------------
  # Multipart Support
  # ---------------------------------------------------------------------------

  defp multipart?(operation) do
    content = get_in(operation, ["requestBody", "content"]) || %{}
    Map.has_key?(content, "multipart/form-data")
  end

  defp extract_multipart_meta(operation, spec) do
    schema = get_in(operation, ["requestBody", "content", "multipart/form-data", "schema"]) || %{}
    props = resolve_properties(schema, spec)

    {file_props, other_props} =
      Enum.split_with(props, fn {_name, ps} ->
        Map.get(ps, "format") == "binary"
      end)

    file_field =
      case file_props do
        [{name, _} | _] -> name
        _ -> nil
      end

    {options_field, options_props, options_required} =
      case Enum.find(other_props, fn {_n, ps} ->
             Map.has_key?(ps, "properties") or Map.has_key?(ps, "$ref") or
               Map.has_key?(ps, "allOf")
           end) do
        {name, ps} ->
          inner_props = resolve_properties(ps, spec)
          inner_required = resolve_required(ps, spec)
          {name, inner_props, inner_required}

        nil ->
          {nil, [], []}
      end

    %{
      file_field: file_field,
      options_field: options_field,
      options_props: options_props,
      options_required: options_required
    }
  end

  defp generate_multipart_function(method, path, operation, spec, func_name, summary, tag) do
    meta = extract_multipart_meta(operation, spec)
    http_method = String.upcase(method)
    has_options? = meta.options_props != []

    body_schema_code =
      if has_options?, do: generate_schema(func_name, meta.options_props, meta.options_required), else: nil

    body_key_mapping_code =
      if has_options?, do: generate_key_mapping(func_name, meta.options_props), else: nil

    doc = build_multipart_doc(summary, http_method, path, tag, func_name, has_options?, meta)

    {sig, body} = build_multipart_function_body(func_name, method, path, meta, has_options?, false)
    {bang_sig, bang_body} = build_multipart_function_body(func_name, method, path, meta, has_options?, true)

    deprecated_code = build_deprecated(operation)
    spec_code = build_multipart_typespec(func_name, has_options?, false)
    bang_spec_code = build_multipart_typespec(func_name, has_options?, true)

    parts = [
      body_schema_code,
      body_key_mapping_code,
      doc,
      deprecated_code,
      spec_code,
      "  #{sig}",
      body,
      "",
      doc_bang(func_name),
      deprecated_code,
      bang_spec_code,
      "  #{bang_sig}",
      bang_body,
      ""
    ]

    parts |> Enum.reject(&is_nil/1) |> Enum.join("\n")
  end

  defp build_multipart_function_body(func_name, method, path, meta, has_options?, bang?) do
    req_method = String.to_atom(method)
    fn_name = if bang?, do: "#{func_name}!", else: func_name
    req_fn = if bang?, do: "#{req_method}!", else: "#{req_method}"

    sig =
      if has_options? do
        "def #{fn_name}(file, params \\\\ [], opts \\\\ []) do"
      else
        "def #{fn_name}(file, opts \\\\ []) do"
      end

    options_part_text =
      if has_options? and not is_nil(meta.options_field) do
        "{#{inspect(meta.options_field)}, Jason.encode!(to_body(params, @#{func_name}_key_mapping))}, "
      else
        ""
      end

    indent = if bang?, do: "    ", else: "      "

    send_lines = [
      "#{indent}file_part =",
      "#{indent}  case content_type do",
      "#{indent}    nil -> {data, filename: filename}",
      "#{indent}    ct -> {data, filename: filename, content_type: ct}",
      "#{indent}  end",
      "",
      "#{indent}multipart = [#{options_part_text}{#{inspect(meta.file_field)}, file_part}]",
      "",
      "#{indent}Req.#{req_fn}(client(opts), url: \"#{escape_string_literal(path)}\", form_multipart: multipart)"
    ]

    lines =
      if bang? do
        validate = if has_options?, do: ["    params = NimbleOptions.validate!(params, @#{func_name}_schema)"], else: []

        validate ++
          [
            "    filename = Keyword.fetch!(file, :filename)",
            "    data = Keyword.fetch!(file, :data)",
            "    content_type = Keyword.get(file, :content_type)",
            "",
            "    if not is_binary(filename) or filename == \"\" do",
            "      raise ArgumentError, \"filename cannot be empty\"",
            "    end",
            "",
            "    if is_nil(data) do",
            "      raise ArgumentError, \"file data cannot be empty\"",
            "    end",
            ""
          ] ++ send_lines ++ ["  end"]
      else
        validate =
          if has_options?, do: ["{:ok, params} <- NimbleOptions.validate(params, @#{func_name}_schema)"], else: []

        clauses =
          validate ++
            [
              "{:ok, filename} <- fetch_file_field(file, :filename)",
              ":ok <- validate_filename(filename)",
              "{:ok, data} <- fetch_file_field(file, :data)",
              ":ok <- validate_data(data)"
            ]

        ["    with #{Enum.join(clauses, ",\n         ")} do", "      content_type = Keyword.get(file, :content_type)", ""] ++
          send_lines ++ ["    end", "  end"]
      end

    {sig, Enum.join(lines, "\n") <> "\n"}
  end

  defp build_multipart_typespec(func_name, has_options?, bang?) do
    name = if bang?, do: "#{func_name}!", else: func_name
    return_type = if bang?, do: "Req.Response.t()", else: "response()"

    args =
      if has_options? do
        "keyword(), keyword(), keyword()"
      else
        "keyword(), keyword()"
      end

    "  @spec #{name}(#{args}) :: #{return_type}"
  end

  defp build_multipart_doc(summary, http_method, path, tag, func_name, has_options?, meta) do
    bt = <<96>>

    parts = [
      "  @doc \"\"\"",
      "  #{escape_source_text(summary)}",
      "",
      "  #{bt}#{escape_source_text(http_method)} #{escape_source_text(path)}#{bt}",
      "",
      "  Sends a #{bt}multipart/form-data#{bt} request."
    ]

    parts = if tag != "", do: parts ++ ["", "  Tag: #{escape_source_text(tag)}"], else: parts

    parts =
      parts ++
        [
          "",
          "  ## File",
          "",
          "  Pass #{bt}file#{bt} as a keyword list:",
          "",
          "    * #{bt}:filename#{bt} (required) - The filename to send.",
          "    * #{bt}:data#{bt} (required) - The file contents as a binary.",
          "    * #{bt}:content_type#{bt} (optional) - The MIME type of the file."
        ]

    parts =
      if has_options? do
        parts ++
          [
            "",
            "  ## Parameters",
            "",
            "  Validated by #{bt}NimbleOptions#{bt}. Pass options as a keyword list with snake_case keys.",
            "  These are JSON-encoded and sent as the #{bt}#{escape_source_text(meta.options_field)}#{bt} multipart field.",
            "  See #{bt}@#{func_name}_schema#{bt} for the full schema."
          ]
      else
        parts
      end

    parts =
      parts ++
        [
          "",
          "  ## Returns",
          "",
          "    * #{bt}{:ok, %Req.Response{}}#{bt} on success",
          "    * #{bt}{:error, exception}#{bt} on HTTP or validation failure",
          "  \"\"\""
        ]

    Enum.join(parts, "\n")
  end

  # ---------------------------------------------------------------------------
  # Schema Extraction
  # ---------------------------------------------------------------------------

  defp extract_body_properties(operation, spec) do
    schema = get_in(operation, ["requestBody", "content", "application/json", "schema"]) || %{}
    resolve_properties(schema, spec)
  end

  defp extract_required_keys(operation, spec) do
    schema = get_in(operation, ["requestBody", "content", "application/json", "schema"]) || %{}
    resolve_required(schema, spec)
  end

  defp resolve_properties(schema, spec) do
    cond do
      Map.has_key?(schema, "$ref") ->
        resolved = resolve_ref(schema["$ref"], spec)
        resolve_properties(resolved, spec)

      Map.has_key?(schema, "allOf") ->
        schema["allOf"]
        |> Enum.flat_map(fn sub -> resolve_properties(sub, spec) end)
        |> Enum.uniq_by(fn {name, _} -> name end)

      Map.has_key?(schema, "properties") ->
        schema["properties"]
        |> Enum.map(fn {name, prop_schema} ->
          prop_schema = resolve_if_ref(prop_schema, spec)
          {name, prop_schema}
        end)

      true ->
        []
    end
  end

  defp resolve_required(schema, spec) do
    cond do
      Map.has_key?(schema, "$ref") ->
        resolved = resolve_ref(schema["$ref"], spec)
        resolve_required(resolved, spec)

      Map.has_key?(schema, "allOf") ->
        schema["allOf"]
        |> Enum.flat_map(fn sub -> resolve_required(sub, spec) end)
        |> Enum.uniq()

      Map.has_key?(schema, "required") ->
        schema["required"]

      true ->
        []
    end
  end

  defp resolve_ref(ref, spec) do
    path = ref |> String.trim_leading("#/") |> String.split("/")
    get_in(spec, path) || %{}
  end

  defp resolve_if_ref(%{"$ref" => ref}, spec), do: resolve_ref(ref, spec)
  defp resolve_if_ref(schema, _spec), do: schema

  # ---------------------------------------------------------------------------
  # NimbleOptions Schema Generation (body params)
  # ---------------------------------------------------------------------------

  defp generate_schema(func_name, properties, required_keys) do
    opts =
      properties
      |> Enum.map(fn {name, prop_schema} ->
        snake = to_snake_case(name)
        required = name in required_keys
        doc = Map.get(prop_schema, "description", "")

        parts =
          case Map.fetch(@type_overrides, {func_name, name}) do
            {:ok, type} -> ["type: #{type}"]
            :error -> openapi_to_nimble_parts(prop_schema)
          end

        parts = if required, do: parts ++ ["required: true"], else: parts
        parts = if doc != "", do: parts ++ ["doc: #{inspect(doc)}"], else: parts

        "    #{snake}: [#{Enum.join(parts, ", ")}]"
      end)
      |> Enum.join(",\n")

    "  @#{func_name}_schema NimbleOptions.new!([\n#{opts}\n  ])\n"
  end

  defp generate_key_mapping(func_name, properties) do
    "  @#{func_name}_key_mapping #{key_mapping(properties)}\n"
  end

  # A closed object maps to {json_key, nested_mapping}, so to_body sends its exact
  # wire names and an empty keyword list as {}.
  defp key_mapping(properties) do
    mappings =
      properties
      |> Enum.map(fn
        {name, %{"type" => "object", "properties" => nested, "additionalProperties" => false}} ->
          "#{to_snake_case(name)}: {#{inspect(name)}, #{key_mapping(nested)}}"

        {name, _} ->
          "#{to_snake_case(name)}: #{inspect(name)}"
      end)
      |> Enum.join(", ")

    "%{#{mappings}}"
  end

  # ---------------------------------------------------------------------------
  # NimbleOptions Schema Generation (query params)
  # ---------------------------------------------------------------------------

  defp generate_query_schema(func_name, query_params) do
    opts =
      query_params
      |> Enum.map(fn param ->
        name = Map.get(param, "name")
        snake = to_snake_case(name)
        param_schema = Map.get(param, "schema", %{})
        type = openapi_to_nimble_type(param_schema)
        required = Map.get(param, "required", false)
        doc = Map.get(param, "description", "")

        parts = ["type: #{type}"]
        parts = if required, do: parts ++ ["required: true"], else: parts
        parts = if doc != "", do: parts ++ ["doc: #{inspect(doc)}"], else: parts

        "    #{snake}: [#{Enum.join(parts, ", ")}]"
      end)
      |> Enum.join(",\n")

    "  @#{func_name}_query_schema NimbleOptions.new!([\n#{opts}\n  ])\n"
  end

  defp generate_query_key_mapping(func_name, query_params) do
    mappings =
      query_params
      |> Enum.map(fn param ->
        name = Map.get(param, "name")
        snake = to_snake_case(name)
        "#{snake}: #{inspect(name)}"
      end)
      |> Enum.join(", ")

    "  @#{func_name}_query_key_mapping %{#{mappings}}\n"
  end

  # ---------------------------------------------------------------------------
  # OpenAPI → NimbleOptions type mapping
  # ---------------------------------------------------------------------------

  # A closed object (additionalProperties: false) validates its keys, so a typo
  # fails locally instead of at the API.
  defp openapi_to_nimble_parts(
         %{"type" => "object", "properties" => properties, "additionalProperties" => false} = schema
       ) do
    required = Map.get(schema, "required", [])

    keys =
      properties
      |> Enum.map(fn {name, property_schema} ->
        parts = openapi_to_nimble_parts(property_schema)
        parts = if name in required, do: parts ++ ["required: true"], else: parts
        "#{to_snake_case(name)}: [#{Enum.join(parts, ", ")}]"
      end)
      |> Enum.join(", ")

    ["type: :keyword_list", "keys: [#{keys}]"]
  end

  defp openapi_to_nimble_parts(schema) do
    ["type: #{openapi_to_nimble_type(schema)}"]
  end

  defp openapi_to_nimble_type(%{"type" => "string", "enum" => values}) do
    inspected = values |> Enum.map(&atom_literal/1) |> Enum.join(", ")
    "{:or, [{:in, [#{inspected}]}, :string]}"
  end

  defp openapi_to_nimble_type(%{"type" => "string"}), do: ":string"
  defp openapi_to_nimble_type(%{"type" => "integer"}), do: ":integer"
  defp openapi_to_nimble_type(%{"type" => "number"}), do: "{:or, [:integer, :float]}"
  defp openapi_to_nimble_type(%{"type" => "boolean"}), do: ":boolean"

  defp openapi_to_nimble_type(%{"type" => "array", "items" => %{"type" => "string"}}) do
    "{:list, :string}"
  end

  defp openapi_to_nimble_type(%{"type" => "array"}) do
    "{:list, :any}"
  end

  # Object with no properties defined → arbitrary data (JSON Schema, headers, etc.)
  defp openapi_to_nimble_type(%{"type" => "object", "properties" => _}), do: ":keyword_list"
  defp openapi_to_nimble_type(%{"type" => "object"}), do: ":any"

  # Ref-resolved objects with known properties
  defp openapi_to_nimble_type(%{"properties" => _}), do: ":keyword_list"

  # allOf composition — if any sub-schema has properties, treat as keyword_list
  defp openapi_to_nimble_type(%{"allOf" => sub_schemas}) do
    if Enum.any?(sub_schemas, fn s -> Map.has_key?(s, "properties") or Map.has_key?(s, "$ref") end) do
      ":keyword_list"
    else
      ":any"
    end
  end

  defp openapi_to_nimble_type(_), do: ":any"

  # ---------------------------------------------------------------------------
  # Doc Generation
  # ---------------------------------------------------------------------------

  # OpenAPI marks a retiring operation with `deprecated: true`. Elixir's
  # @deprecated turns that into a compiler warning at the caller.
  def build_deprecated(operation) do
    if Map.get(operation, "deprecated", false) do
      note =
        Map.get(operation, "x-deprecation-note") ||
          "Deprecated in the Firecrawl API. See the function docs for the replacement."

      "  @deprecated #{inspect(to_string(note))}"
    end
  end

  # Spec text is fetched from the network and lands inside generated heredocs,
  # where Elixir would run #{} as code at compile time. Neutralise that, the
  # heredoc terminator, and stray backslashes.
  def escape_source_text(text) do
    text
    |> to_string()
    |> String.replace("\\", "\\\\")
    |> String.replace(~S(#{), ~S(\#{))
    |> String.replace(~S("""), ~S(\"\"\"))
  end

  # Same job for text that lands inside a generated "..." literal, where a
  # quote or #{} would end or execute it. Path templates keep their {param}
  # holes untouched so build_elixir_path can turn them into interpolations.
  def escape_string_literal(text) do
    text
    |> to_string()
    |> String.replace("\\", "\\\\")
    |> String.replace("\"", "\\\"")
    |> String.replace(~S(#{), ~S(\#{))
  end

  defp build_doc(
         summary,
         http_method,
         path,
         tag,
         path_params,
         query_param_names,
         has_body,
         func_name,
         has_query_schema
       ) do
    bt = <<96>>

    parts = [
      "  @doc \"\"\"",
      "  #{escape_source_text(summary)}",
      "",
      "  #{bt}#{escape_source_text(http_method)} #{escape_source_text(path)}#{bt}"
    ]

    parts = if tag != "", do: parts ++ ["", "  Tag: #{escape_source_text(tag)}"], else: parts

    parts =
      if path_params != [] do
        param_docs =
          Enum.map(path_params, fn p ->
            "    * #{bt}#{to_snake_case(p)}#{bt} - Path parameter #{bt}#{escape_source_text(p)}#{bt}"
          end)

        parts ++ ["", "  ## Path Parameters", ""] ++ param_docs
      else
        parts
      end

    parts =
      if has_body do
        parts ++
          [
            "",
            "  ## Parameters",
            "",
            "  Validated by #{bt}NimbleOptions#{bt}. Pass params as a keyword list with snake_case keys.",
            "  See #{bt}@#{func_name}_schema#{bt} for the full schema."
          ]
      else
        parts
      end

    parts =
      if has_query_schema do
        param_docs =
          Enum.map(query_param_names, fn p ->
            "    * #{bt}#{to_snake_case(p)}#{bt} — query parameter #{bt}#{escape_source_text(p)}#{bt}"
          end)

        parts ++ ["", "  ## Query Parameters", ""] ++ param_docs
      else
        parts
      end

    parts =
      parts ++
        [
          "",
          "  ## Returns",
          "",
          "    * #{bt}{:ok, %Req.Response{}}#{bt} on success",
          "    * #{bt}{:error, exception}#{bt} on HTTP or validation failure",
          "  \"\"\""
        ]

    Enum.join(parts, "\n")
  end

  defp doc_bang(func_name) do
    bt = <<96>>
    "  @doc \"\"\"
  Bang variant of #{bt}#{func_name}#{bt}. Raises on error.
  \"\"\""
  end

  # ---------------------------------------------------------------------------
  # Typespec Generation
  # ---------------------------------------------------------------------------

  defp build_typespec(func_name, path_params, has_params, bang?) do
    name = if bang?, do: "#{func_name}!", else: func_name
    return_type = if bang?, do: "Req.Response.t()", else: "response()"

    path_types = Enum.map(path_params, fn _ -> "String.t()" end)
    param_types = if has_params, do: ["keyword()"], else: []
    all_types = path_types ++ param_types ++ ["keyword()"]

    "  @spec #{name}(#{Enum.join(all_types, ", ")}) :: #{return_type}"
  end

  # ---------------------------------------------------------------------------
  # Function Body Generation
  # ---------------------------------------------------------------------------

  defp build_function_body(
         func_name,
         method,
         path,
         path_params,
         _query_param_names,
         has_body,
         has_query_schema,
         bang?
       ) do
    elixir_path = build_elixir_path(path, path_params)
    req_method = String.to_atom(method)
    fn_name = if bang?, do: "#{func_name}!", else: func_name
    req_fn = if bang?, do: "#{req_method}!", else: "#{req_method}"

    cond do
      # POST/PUT/PATCH with body, no path params
      has_body and path_params == [] ->
        sig = "def #{fn_name}(params \\\\ [], opts \\\\ []) do"

        body =
          if bang? do
            """
                params = NimbleOptions.validate!(params, @#{func_name}_schema)
                Req.#{req_fn}(client(opts), url: "#{elixir_path}", json: to_body(params, @#{func_name}_key_mapping))
              end
            """
          else
            """
                with {:ok, params} <- NimbleOptions.validate(params, @#{func_name}_schema) do
                  Req.#{req_fn}(client(opts), url: "#{elixir_path}", json: to_body(params, @#{func_name}_key_mapping))
                end
              end
            """
          end

        {sig, body}

      # POST/PUT/PATCH with body and path params
      has_body and path_params != [] ->
        args = Enum.map(path_params, &to_snake_case/1) |> Enum.join(", ")
        sig = "def #{fn_name}(#{args}, params \\\\ [], opts \\\\ []) do"

        body =
          if bang? do
            """
                params = NimbleOptions.validate!(params, @#{func_name}_schema)
                Req.#{req_fn}(client(opts), url: "#{elixir_path}", json: to_body(params, @#{func_name}_key_mapping))
              end
            """
          else
            """
                with {:ok, params} <- NimbleOptions.validate(params, @#{func_name}_schema) do
                  Req.#{req_fn}(client(opts), url: "#{elixir_path}", json: to_body(params, @#{func_name}_key_mapping))
                end
              end
            """
          end

        {sig, body}

      # GET/DELETE with path params and query params (validated)
      path_params != [] and has_query_schema ->
        args = Enum.map(path_params, &to_snake_case/1) |> Enum.join(", ")
        sig = "def #{fn_name}(#{args}, params \\\\ [], opts \\\\ []) do"

        body =
          if bang? do
            """
                params = NimbleOptions.validate!(params, @#{func_name}_query_schema)
                Req.#{req_fn}(client(opts), url: "#{elixir_path}", params: to_query(params, @#{func_name}_query_key_mapping))
              end
            """
          else
            """
                with {:ok, params} <- NimbleOptions.validate(params, @#{func_name}_query_schema) do
                  Req.#{req_fn}(client(opts), url: "#{elixir_path}", params: to_query(params, @#{func_name}_query_key_mapping))
                end
              end
            """
          end

        {sig, body}

      # GET/DELETE with path params only
      path_params != [] ->
        args = Enum.map(path_params, &to_snake_case/1) |> Enum.join(", ")
        sig = "def #{fn_name}(#{args}, opts \\\\ []) do"
        body = "    Req.#{req_fn}(client(opts), url: \"#{elixir_path}\")\n  end\n"
        {sig, body}

      # GET/DELETE without path params but with query params (validated)
      has_query_schema ->
        sig = "def #{fn_name}(params \\\\ [], opts \\\\ []) do"

        body =
          if bang? do
            """
                params = NimbleOptions.validate!(params, @#{func_name}_query_schema)
                Req.#{req_fn}(client(opts), url: "#{elixir_path}", params: to_query(params, @#{func_name}_query_key_mapping))
              end
            """
          else
            """
                with {:ok, params} <- NimbleOptions.validate(params, @#{func_name}_query_schema) do
                  Req.#{req_fn}(client(opts), url: "#{elixir_path}", params: to_query(params, @#{func_name}_query_key_mapping))
                end
              end
            """
          end

        {sig, body}

      # No params at all
      true ->
        sig = "def #{fn_name}(opts \\\\ []) do"
        body = "    Req.#{req_fn}(client(opts), url: \"#{elixir_path}\")\n  end\n"
        {sig, body}
    end
  end

  defp build_elixir_path(path, path_params) do
    elixir_path =
      Enum.reduce(path_params, escape_string_literal(path), fn param, acc ->
        snake = to_snake_case(param)
        String.replace(acc, "{#{param}}", "\#{#{snake}}")
      end)

    if Regex.match?(~r/(?<!#)\{[^}]*\}/, elixir_path) do
      raise ArgumentError, "unresolved path parameter in #{inspect(path)}"
    end

    elixir_path
  end

  # ---------------------------------------------------------------------------
  # Utilities
  # ---------------------------------------------------------------------------

  # Returns a valid atom literal string. Quotes values with special chars.
  defp atom_literal(value) do
    if Regex.match?(~r/^[a-zA-Z_][a-zA-Z0-9_]*$/, value) do
      ":#{value}"
    else
      ":" <> inspect(to_string(value))
    end
  end

  defp to_snake_case(str) do
    str
    # Normalize plural acronyms: "URLs" → "Urls", "IDs" → "Ids"
    |> String.replace(~r/([A-Z]{2,})s/, fn match ->
      first = String.first(match)
      rest = match |> String.slice(1..-1//1) |> String.downcase()
      first <> rest
    end)
    |> String.replace(~r/([a-z\d])([A-Z])/, "\\1_\\2")
    |> String.replace(~r/([A-Z]+)([A-Z][a-z])/, "\\1_\\2")
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9_]/, "_")
    |> String.replace(~r/_+/, "_")
    |> String.trim_leading("_")
    |> String.trim_trailing("_")
  end

  defp extract_public_functions(code) do
    Regex.scan(~r/^ +def +([a-z_][a-z0-9_]*!?)\(/m, code, capture: :all_but_first)
    |> List.flatten()
    |> MapSet.new()
  end

  defp detect_bump_type("", _new_code), do: :patch

  defp detect_bump_type(old_code, new_code) do
    old_fns = extract_public_functions(old_code)
    new_fns = extract_public_functions(new_code)

    removed = MapSet.difference(old_fns, new_fns)
    added = MapSet.difference(new_fns, old_fns)

    cond do
      MapSet.size(removed) > 0 ->
        IO.puts("Breaking change: removed functions: #{removed |> MapSet.to_list() |> Enum.join(", ")}")
        :major

      MapSet.size(added) > 0 ->
        IO.puts("New functions: #{added |> MapSet.to_list() |> Enum.join(", ")}")
        :minor

      true ->
        :patch
    end
  end

  defp bump_version(bump_type) do
    content = File.read!(@mix_file)

    case Regex.run(~r/@version\s+"(\d+)\.(\d+)\.(\d+)"/, content) do
      [full_match, major, minor, patch] ->
        {major, minor, patch} =
          {String.to_integer(major), String.to_integer(minor), String.to_integer(patch)}

        new_version =
          case bump_type do
            :major -> "#{major + 1}.0.0"
            :minor -> "#{major}.#{minor + 1}.0"
            :patch -> "#{major}.#{minor}.#{patch + 1}"
          end

        new_content = String.replace(content, full_match, ~s|@version "#{new_version}"|)
        File.write!(@mix_file, new_content)
        IO.puts("Bumped version to #{new_version} (#{bump_type})")

      _ ->
        IO.puts("Warning: could not find @version in #{@mix_file} — skipping version bump.")
    end
  end
end

unless Code.ensure_loaded?(Mix) and Mix.env() == :test, do: Firecrawl.Generator.run()
