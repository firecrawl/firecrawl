defmodule Firecrawl.MixProject do
  use Mix.Project

  @version "1.3.0"
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
      description: "Auto-generated Elixir client for the Firecrawl API v2",
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
