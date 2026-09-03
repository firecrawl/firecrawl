Code.require_file("../generate.exs", __DIR__)

defmodule Firecrawl.GeneratorTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureIO

  # The generator pulls the OpenAPI spec over the network and writes its text
  # into Elixir source. Anything that reaches a string literal or heredoc must
  # arrive as data, never as code that runs while the SDK compiles.
  @marker Path.join(System.tmp_dir!(), "firecrawl_generator_test_pwned")

  # No double quotes anywhere, so an escaper that only handles quotes leaves
  # the interpolation intact.
  @hostile "see \#{File.write!(~c'#{@marker}', ~c'x')} for details"

  setup do
    File.rm(@marker)
    on_exit(fn -> File.rm(@marker) end)
    :ok
  end

  defp compile_quietly(source) do
    capture_io(:stderr, fn -> Code.compile_string(source) end)
  end

  describe "build_deprecated/1" do
    test "emits nothing when the operation is not deprecated" do
      assert Firecrawl.Generator.build_deprecated(%{}) == nil
      assert Firecrawl.Generator.build_deprecated(%{"deprecated" => false}) == nil
    end

    test "falls back to a generic note" do
      line = Firecrawl.Generator.build_deprecated(%{"deprecated" => true})
      assert line =~ ~r/^  @deprecated "Deprecated in the Firecrawl API/
    end

    test "a hostile note is carried as data and cannot run at compile time" do
      line =
        Firecrawl.Generator.build_deprecated(%{
          "deprecated" => true,
          "x-deprecation-note" => @hostile
        })

      warnings =
        compile_quietly("""
        defmodule Firecrawl.GeneratorTest.Hostile do
        #{line}
          def f, do: :ok
        end

        defmodule Firecrawl.GeneratorTest.HostileCaller do
          def g, do: Firecrawl.GeneratorTest.Hostile.f()
        end
        """)

      refute File.exists?(@marker), "the note was evaluated while compiling"
      # The caller's deprecation warning must quote the note verbatim, which
      # proves it survived as a plain string rather than being interpreted.
      assert warnings =~ "is deprecated. " <> @hostile
    end

    test "quotes, backslashes and newlines cannot break out of the literal" do
      note = ~S(a "quoted" note with a \ backslash) <> "\nand a newline"

      line =
        Firecrawl.Generator.build_deprecated(%{
          "deprecated" => true,
          "x-deprecation-note" => note
        })

      warnings =
        compile_quietly("""
        defmodule Firecrawl.GeneratorTest.Escapes do
        #{line}
          def f, do: :ok
        end

        defmodule Firecrawl.GeneratorTest.EscapesCaller do
          def g, do: Firecrawl.GeneratorTest.Escapes.f()
        end
        """)

      assert warnings =~ "is deprecated. " <> note
    end
  end

  describe "escape_source_text/1" do
    test "leaves ordinary spec text untouched" do
      assert Firecrawl.Generator.escape_source_text("Scrape a single URL") ==
               "Scrape a single URL"
    end

    test "a hostile summary inside a @doc heredoc cannot run at compile time" do
      summary = Firecrawl.Generator.escape_source_text(@hostile)

      compile_quietly("""
      defmodule Firecrawl.GeneratorTest.HostileDoc do
        @doc \"\"\"
        #{summary}
        \"\"\"
        def f, do: :ok
      end
      """)

      refute File.exists?(@marker), "the summary was evaluated while compiling"
    end

    test "a heredoc terminator in the summary does not end the docstring early" do
      summary =
        Firecrawl.Generator.escape_source_text(~S(ends the doc """ def injected, do: :owned))

      [{mod, _}] =
        Code.compile_string("""
        defmodule Firecrawl.GeneratorTest.Terminator do
          @doc \"\"\"
          #{summary}
          \"\"\"
          def f, do: :ok
        end
        """)

      refute function_exported?(mod, :injected, 0)
      assert function_exported?(mod, :f, 0)
    end
  end
end
