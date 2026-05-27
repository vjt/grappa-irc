defmodule Grappa.Deploy.PreflightTest do
  # async: true — pure logic, no global state.
  use ExUnit.Case, async: true

  alias Grappa.Deploy.Preflight

  describe "classify_paths/1 — Class 1: dep / build config" do
    test "mix.lock → cold with :mix_deps reason" do
      assert {:cold, reasons} = Preflight.classify_paths(["mix.lock"])
      assert {:mix_deps, ["mix.lock"]} in reasons
    end

    test "mix.exs → cold with :mix_deps reason" do
      assert {:cold, reasons} = Preflight.classify_paths(["mix.exs"])
      assert {:mix_deps, ["mix.exs"]} in reasons
    end
  end

  describe "classify_paths/1 — Class 2: supervision tree" do
    test "lib/grappa/application.ex → cold with :application reason" do
      assert {:cold, reasons} = Preflight.classify_paths(["lib/grappa/application.ex"])
      assert {:application, ["lib/grappa/application.ex"]} in reasons
    end
  end

  describe "classify_paths/1 — Class 4: image substrate" do
    test "Dockerfile → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["Dockerfile"])
      assert {:image_substrate, ["Dockerfile"]} in reasons
    end

    test "compose.yaml → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["compose.yaml"])
      assert {:image_substrate, ["compose.yaml"]} in reasons
    end

    test "compose.override.yaml → cold (H20 gap)" do
      assert {:cold, reasons} = Preflight.classify_paths(["compose.override.yaml"])
      assert {:image_substrate, ["compose.override.yaml"]} in reasons
    end

    test "compose.oneshot.yaml → cold (H20 gap)" do
      assert {:cold, reasons} = Preflight.classify_paths(["compose.oneshot.yaml"])
      assert {:image_substrate, ["compose.oneshot.yaml"]} in reasons
    end

    test "bin/start.sh → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["bin/start.sh"])
      assert {:image_substrate, ["bin/start.sh"]} in reasons
    end

    test "bin/grappa → cold (H20 gap — operator dispatcher)" do
      assert {:cold, reasons} = Preflight.classify_paths(["bin/grappa"])
      assert {:image_substrate, ["bin/grappa"]} in reasons
    end

    test ".dockerignore → cold (H20 gap)" do
      assert {:cold, reasons} = Preflight.classify_paths([".dockerignore"])
      assert {:image_substrate, [".dockerignore"]} in reasons
    end

    test "infra/freebsd/rc.d/grappa → cold (jail rc wrapper, read at service start)" do
      file = "infra/freebsd/rc.d/grappa"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:image_substrate, [^file]} = List.keyfind(reasons, :image_substrate, 0)
    end

    test "infra/freebsd/deploy.sh → cold (jail deploy script — running it from old version risks divergent behavior)" do
      file = "infra/freebsd/deploy.sh"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:image_substrate, [^file]} = List.keyfind(reasons, :image_substrate, 0)
    end

    test "infra/freebsd/jail_release.sh → HOT (operator verb, invoked on-demand, no service restart impact)" do
      assert {:hot, []} = Preflight.classify_paths(["infra/freebsd/jail_release.sh"])
    end

    test "infra/freebsd/grappa.env.example → HOT (template only, /usr/local/etc/grappa/grappa.env is out-of-repo)" do
      assert {:hot, []} = Preflight.classify_paths(["infra/freebsd/grappa.env.example"])
    end
  end

  describe "classify_paths/1 — Class 5: migrations" do
    test "new migration → cold (REV-B live-repro gap)" do
      file = "priv/repo/migrations/20260522000000_add_thing.exs"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:migration, [^file]} = List.keyfind(reasons, :migration, 0)
    end

    test "edited migration → cold" do
      file = "priv/repo/migrations/99999999999999_smoke.exs"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:migration, [^file]} = List.keyfind(reasons, :migration, 0)
    end
  end

  describe "classify_paths/1 — Class 6: nginx + infra/snippets" do
    test "infra/nginx.conf → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["infra/nginx.conf"])
      assert {:nginx, ["infra/nginx.conf"]} in reasons
    end

    test "infra/snippets/security-headers.conf → cold" do
      file = "infra/snippets/security-headers.conf"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
    end

    test "infra/snippets/admin/cors.conf → cold (H20 deeper-paths gap)" do
      file = "infra/snippets/admin/cors.conf"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
    end

    test "infra/freebsd/nginx.conf → cold (jail nginx config, parallel to Docker's infra/nginx.conf)" do
      file = "infra/freebsd/nginx.conf"
      assert {:cold, reasons} = Preflight.classify_paths([file])
      assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
    end
  end

  describe "classify_paths/1 — Class 7 (NEW H21+H20): config/*.exs" do
    test "config/config.exs → cold (H21 SECRET_SIGNING_SALT motivation)" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/config.exs"])
      assert {:config, ["config/config.exs"]} in reasons
    end

    test "config/runtime.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/runtime.exs"])
      assert {:config, ["config/runtime.exs"]} in reasons
    end

    test "config/dev.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/dev.exs"])
      assert {:config, ["config/dev.exs"]} in reasons
    end

    test "config/prod.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/prod.exs"])
      assert {:config, ["config/prod.exs"]} in reasons
    end

    test "config/test.exs → cold (test/dev config drift can still affect prod gates)" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/test.exs"])
      assert {:config, ["config/test.exs"]} in reasons
    end
  end

  describe "classify_paths/1 — HOT path" do
    test "empty diff → hot" do
      assert {:hot, []} = Preflight.classify_paths([])
    end

    test "lib/grappa/scrollback.ex (regular module) → hot when state-shape check is skipped" do
      assert {:hot, []} = Preflight.classify_paths(["lib/grappa/scrollback.ex"])
    end

    test "cicchetto/src/lib/foo.ts → hot (cic-only is hot)" do
      assert {:hot, []} = Preflight.classify_paths(["cicchetto/src/lib/foo.ts"])
    end

    test "docs/foo.md → hot" do
      assert {:hot, []} = Preflight.classify_paths(["docs/checkpoints/2026-05-22-cp39.md"])
    end

    test "test/grappa/foo_test.exs → hot (tests don't ship in prod boot)" do
      assert {:hot, []} = Preflight.classify_paths(["test/grappa/foo_test.exs"])
    end
  end

  describe "classify_paths/1 — multi-class diff" do
    test "Dockerfile + mix.lock → cold with both reasons" do
      assert {:cold, reasons} = Preflight.classify_paths(["Dockerfile", "mix.lock"])
      assert {:mix_deps, ["mix.lock"]} in reasons
      assert {:image_substrate, ["Dockerfile"]} in reasons
    end

    test "mix.lock + lib/foo.ex → cold (single reason filters out hot file)" do
      assert {:cold, reasons} = Preflight.classify_paths(["mix.lock", "lib/grappa/foo.ex"])
      assert {:mix_deps, ["mix.lock"]} in reasons
    end
  end

  describe "long_lived_module_files/0 — SoT coupling (C4)" do
    test "returns the file path for every module in LongLivedModules.all/0" do
      files = Preflight.long_lived_module_files()
      modules = Grappa.HotReload.LongLivedModules.all()
      assert length(files) == length(modules)

      # Each module's expected file path is present.
      for mod <- modules do
        expected = module_to_path(mod)
        assert expected in files, "expected #{expected} for #{inspect(mod)} in #{inspect(files)}"
      end
    end

    test "Grappa.Session.Backoff → lib/grappa/session/backoff.ex" do
      assert "lib/grappa/session/backoff.ex" in Preflight.long_lived_module_files()
    end

    test "Grappa.Admission.NetworkCircuit → lib/grappa/admission/network_circuit.ex" do
      assert "lib/grappa/admission/network_circuit.ex" in Preflight.long_lived_module_files()
    end

    test "Grappa.WSPresence → lib/grappa/ws_presence.ex" do
      assert "lib/grappa/ws_presence.ex" in Preflight.long_lived_module_files()
    end

    test "Grappa.IRC.AuthFSM → lib/grappa/irc/auth_fsm.ex" do
      assert "lib/grappa/irc/auth_fsm.ex" in Preflight.long_lived_module_files()
    end

    defp module_to_path(mod) do
      mod
      |> Atom.to_string()
      |> String.replace_prefix("Elixir.Grappa.", "")
      |> Macro.underscore()
      |> then(&"lib/grappa/#{&1}.ex")
    end
  end

  describe "extract_state_block/1 — pure block extractor (replaces awk helper)" do
    test "extracts @type t :: %{...} block" do
      source = """
      defmodule Foo do
        @type t :: %{
                a: integer(),
                b: String.t()
              }

        def hello, do: :world
      end
      """

      block = Preflight.extract_state_block(source)
      assert block =~ "@type t :: %{"
      assert block =~ "a: integer()"
      assert block =~ "b: String.t()"
      refute block =~ "def hello"
    end

    test "extracts defstruct block" do
      source = """
      defmodule Foo do
        defstruct [
          :a,
          :b,
          c: 1
        ]
      end
      """

      block = Preflight.extract_state_block(source)
      assert block =~ "defstruct"
      assert block =~ ":a"
      assert block =~ "c: 1"
    end

    test "extracts both @type t :: and defstruct in one pass" do
      source = """
      defmodule Foo do
        @type t :: %{a: integer()}
        defstruct [:a]
      end
      """

      block = Preflight.extract_state_block(source)
      assert block =~ "@type t"
      assert block =~ "defstruct"
    end

    test "ignores other @type definitions" do
      source = """
      defmodule Foo do
        @type other :: :left | :right
        def hello, do: :world
      end
      """

      assert Preflight.extract_state_block(source) == ""
    end

    test "field-addition inside @type t :: %{...} surfaces as a diff" do
      # The CP28-class bug: field added INSIDE existing block.
      from_src = """
      defmodule Foo do
        @type t :: %{a: integer(), b: String.t()}
      end
      """

      to_src = """
      defmodule Foo do
        @type t :: %{a: integer(), b: String.t(), c: boolean()}
      end
      """

      refute Preflight.extract_state_block(from_src) ==
               Preflight.extract_state_block(to_src)
    end

    test "cosmetic reformatting does not surface as a diff" do
      a = """
      defmodule Foo do
        @type t :: %{a: integer(), b: String.t()}
      end
      """

      b = """
      defmodule Foo do
        @type t :: %{
                a: integer(),
                b: String.t()
              }
      end
      """

      assert Preflight.extract_state_block(a) == Preflight.extract_state_block(b)
    end

    test "returns empty string when no state block present" do
      source = """
      defmodule Foo do
        def hello, do: :world
      end
      """

      assert Preflight.extract_state_block(source) == ""
    end

    test "two distinct unparseable sources NEVER compare equal (REV-C LOW-3)" do
      # If both sources fail to parse, we MUST classify COLD because
      # we can't prove the state-shape didn't change. Tested via
      # `extract_state_block/1` returning a per-source hash sentinel
      # so equality compares to actual content, not to a shared
      # empty-string fallback.
      a = "defmodule A do @type t :: %{a: integer(), unclosed"
      b = "defmodule B do @type t :: %{b: integer(), unclosed"
      refute Preflight.extract_state_block(a) == Preflight.extract_state_block(b)
    end

    test "an unparseable source NEVER compares equal to a successfully-parsed one" do
      unparseable = "defmodule A do @type t :: %{a: integer(), unclosed"

      parseable = """
      defmodule A do
        @type t :: %{a: integer()}
      end
      """

      refute Preflight.extract_state_block(unparseable) ==
               Preflight.extract_state_block(parseable)
    end
  end

  describe "classify_state_shape/3 — long-lived module state-shape diff" do
    test "identical sources → :hot" do
      source = """
      defmodule Foo do
        @type t :: %{a: integer()}
      end
      """

      assert :hot = Preflight.classify_state_shape(source, source)
    end

    test "field added inside @type t :: %{...} → :cold" do
      from_src = """
      defmodule Foo do
        @type t :: %{a: integer()}
      end
      """

      to_src = """
      defmodule Foo do
        @type t :: %{a: integer(), b: String.t()}
      end
      """

      assert :cold = Preflight.classify_state_shape(from_src, to_src)
    end

    test "field added inside defstruct → :cold" do
      from_src = """
      defmodule Foo do
        defstruct [:a, :b]
      end
      """

      to_src = """
      defmodule Foo do
        defstruct [:a, :b, :c]
      end
      """

      assert :cold = Preflight.classify_state_shape(from_src, to_src)
    end

    test "function-body change (no state-shape touch) → :hot" do
      from_src = """
      defmodule Foo do
        @type t :: %{a: integer()}

        def hello, do: :world
      end
      """

      to_src = """
      defmodule Foo do
        @type t :: %{a: integer()}

        def hello, do: :universe
      end
      """

      assert :hot = Preflight.classify_state_shape(from_src, to_src)
    end

    test "cosmetic reformat → :hot" do
      from_src = """
      defmodule Foo do
        @type t :: %{a: integer(), b: String.t()}
      end
      """

      to_src = """
      defmodule Foo do
        @type t :: %{
                a: integer(),
                b: String.t()
              }
      end
      """

      assert :hot = Preflight.classify_state_shape(from_src, to_src)
    end
  end

  describe "classify/4 — full diff classification with injected git" do
    test "no changed paths → :hot" do
      diff_fn = fn _, _ -> [] end
      show_fn = fn _, _ -> nil end
      assert {:hot, []} = Preflight.classify("from", "to", diff_fn, show_fn)
    end

    test "config/runtime.exs touched → :cold with :config reason" do
      diff_fn = fn _, _ -> ["config/runtime.exs"] end
      show_fn = fn _, _ -> nil end
      assert {:cold, reasons} = Preflight.classify("from", "to", diff_fn, show_fn)
      assert {:config, ["config/runtime.exs"]} in reasons
    end

    test "long-lived module file touched + body change only → :hot" do
      diff_fn = fn _, _ -> ["lib/grappa/session/backoff.ex"] end

      show_fn = fn
        "from", "lib/grappa/session/backoff.ex" ->
          "defmodule Grappa.Session.Backoff do\n  def f, do: :a\nend\n"

        "to", "lib/grappa/session/backoff.ex" ->
          "defmodule Grappa.Session.Backoff do\n  def f, do: :b\nend\n"
      end

      assert {:hot, []} = Preflight.classify("from", "to", diff_fn, show_fn)
    end

    test "long-lived module file touched + state-shape field added → :cold with :state_shape" do
      path = "lib/grappa/session/backoff.ex"
      diff_fn = fn _, _ -> [path] end

      show_fn = fn
        "from", ^path ->
          "defmodule Grappa.Session.Backoff do\n  @type t :: %{a: integer()}\nend\n"

        "to", ^path ->
          "defmodule Grappa.Session.Backoff do\n  @type t :: %{a: integer(), b: String.t()}\nend\n"
      end

      assert {:cold, reasons} = Preflight.classify("from", "to", diff_fn, show_fn)
      assert {:state_shape, [^path]} = List.keyfind(reasons, :state_shape, 0)
    end

    test "non-long-lived module file touched → :hot (no state-shape check)" do
      diff_fn = fn _, _ -> ["lib/grappa/scrollback.ex"] end
      # show_fn would crash if called — scrollback is NOT in the
      # long-lived set, so the classifier must not invoke show_fn.
      show_fn = fn _, _ -> raise "should not be called" end
      assert {:hot, []} = Preflight.classify("from", "to", diff_fn, show_fn)
    end

    test "path-class match short-circuits state-shape check" do
      # mix.lock change already triggers :cold; we should not also
      # invoke show_fn on touched long-lived modules in the same diff.
      diff_fn = fn _, _ -> ["mix.lock", "lib/grappa/session/backoff.ex"] end
      show_fn = fn _, _ -> raise "should not be called when path-class already cold" end
      assert {:cold, reasons} = Preflight.classify("from", "to", diff_fn, show_fn)
      assert {:mix_deps, ["mix.lock"]} in reasons
    end
  end
end
