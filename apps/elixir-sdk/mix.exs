defmodule Firecrawl.MixProject do
  use Mix.Project

  @version "1.12.6"
  @source_url "https://github.com/firecrawl/firecrawl/tree/main/apps/elixir-sdk"

  def project do
    [
      app: :firecrawl,
      version: @version,
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      package: package(),
      name: "Firecrawl",
      description: "Elixir client for Firecrawl, the context API for AI agents: search, scrape, parse, crawl, map, and interact with the web, and run Agent and Monitor jobs on the v2 API. Auto-generated from the OpenAPI spec.",
      source_url: @source_url,
      docs: [
        main: "Firecrawl",
        extras: ["README.md"]
      ]
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:req, "~> 0.5"},
      {:nimble_options, "~> 1.1"},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false}
    ]
  end

  defp package do
    [
      files: ~w(lib .formatter.exs mix.exs README.md LICENSE),
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url
      }
    ]
  end
end
