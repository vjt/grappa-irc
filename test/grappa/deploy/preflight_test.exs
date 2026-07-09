defmodule Grappa.Deploy.PreflightTest do
  # async: true — pure logic, no global state.
  use ExUnit.Case, async: true

  alias Grappa.Deploy.Preflight

  @substrates [:docker, :jail]

  describe "classify_paths/2 — Class 1: dep / build config (substrate-independent)" do
    test "mix.lock → cold with :mix_deps reason on both substrates" do
      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths(["mix.lock"], substrate)
        assert {:mix_deps, ["mix.lock"]} in reasons
      end
    end

    test "mix.exs → cold with :mix_deps reason on both substrates" do
      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths(["mix.exs"], substrate)
        assert {:mix_deps, ["mix.exs"]} in reasons
      end
    end
  end

  describe "classify_paths/2 — Class 2: supervision tree (substrate-independent)" do
    test "lib/grappa/application.ex → cold with :application reason on both substrates" do
      for substrate <- @substrates do
        assert {:cold, reasons} =
                 Preflight.classify_paths(["lib/grappa/application.ex"], substrate)

        assert {:application, ["lib/grappa/application.ex"]} in reasons
      end
    end
  end

  describe "classify_paths/2 — Class 4a: Docker image files (COLD docker / HOT jail)" do
    # The 2026-06-10 incident class — see the preflight.ex moduledoc.
    for file <- [
          "Dockerfile",
          ".dockerignore",
          "compose.yaml",
          "compose.override.yaml",
          "compose.override.yaml.example",
          "compose.oneshot.yaml",
          "compose.staging.yaml",
          "bin/start.sh",
          "bin/grappa"
        ] do
      test "#{file} → cold (:image_substrate) on docker" do
        file = unquote(file)
        assert {:cold, reasons} = Preflight.classify_paths([file], :docker)
        assert {:image_substrate, [^file]} = List.keyfind(reasons, :image_substrate, 0)
      end

      test "#{file} → hot on jail (jail never reads Docker image files)" do
        assert {:hot, []} = Preflight.classify_paths([unquote(file)], :jail)
      end
    end
  end

  describe "classify_paths/2 — Class 4a: compose.* is a prefix class, not an enumeration" do
    test "nested compose-named file is NOT class 4a (prefix anchors at repo root)" do
      assert {:hot, []} = Preflight.classify_paths(["cicchetto/e2e/compose.test.yaml"], :docker)
    end
  end

  describe "classify_paths/2 — Class 4b: jail rc.d wrapper (COLD jail / HOT docker)" do
    @rc_d "infra/freebsd/rc.d/grappa"

    test "#{@rc_d} → cold (:rc_d) on jail (rc wrapper read at service start)" do
      assert {:cold, reasons} = Preflight.classify_paths([@rc_d], :jail)
      assert {:rc_d, [@rc_d]} = List.keyfind(reasons, :rc_d, 0)
    end

    test "#{@rc_d} → hot on docker (no rc(8) in the container)" do
      assert {:hot, []} = Preflight.classify_paths([@rc_d], :docker)
    end
  end

  describe "classify_paths/2 — deploy orchestrators stay HOT on both substrates" do
    test "infra/freebsd/deploy.sh → HOT (shell script, doesn't touch live BEAM / rc.d / next-spawn env)" do
      # Live-repro 2026-05-31: two consecutive prod incidents triggered
      # by deploy.sh edits forcing COLD. Restarting the BEAM to pick up
      # a SHELL SCRIPT edit was 30s of pointless downtime — the new
      # bytes are on disk for the next deploy regardless of how this
      # one classifies. See preflight.ex moduledoc for the rule
      # rationale; see d8f354c + 55f0415 for the parallel wait-loop +
      # re-exec-guard fixes that close the COLD-path race this rule
      # avoided in the first place.
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths(["infra/freebsd/deploy.sh"], substrate)
      end
    end

    test "scripts/deploy.sh → HOT (Docker deploy orchestrator; symmetric with the FreeBSD deploy.sh rule)" do
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths(["scripts/deploy.sh"], substrate)
      end
    end

    test "infra/freebsd/jail_release.sh → HOT (operator verb, invoked on-demand, no service restart impact)" do
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths(["infra/freebsd/jail_release.sh"], substrate)
      end
    end

    test "infra/freebsd/grappa.env.example → HOT (template only, /usr/local/etc/grappa/grappa.env is out-of-repo)" do
      for substrate <- @substrates do
        assert {:hot, []} =
                 Preflight.classify_paths(["infra/freebsd/grappa.env.example"], substrate)
      end
    end
  end

  describe "exit_code/1 — verdict-to-CLI exit code contract" do
    test "HOT → 0" do
      assert 0 = Preflight.exit_code({:hot, []})
    end

    test "COLD → 3 (NOT 1: a crashed mix oneshot exits 1, and a crash
          must never be readable as a verdict)" do
      assert 3 = Preflight.exit_code({:cold, [{:mix_deps, ["mix.lock"]}]})
    end
  end

  describe "classify_paths/2 — substrate is a closed set" do
    test "unknown substrate raises FunctionClauseError (loud usage error, never a silent guess)" do
      assert_raise FunctionClauseError, fn ->
        Preflight.classify_paths(["lib/grappa/scrollback.ex"], :freebsd)
      end
    end

    test "string substrate raises FunctionClauseError (atoms only past the CLI boundary)" do
      assert_raise FunctionClauseError, fn ->
        Preflight.classify_paths(["lib/grappa/scrollback.ex"], "docker")
      end
    end
  end

  describe "classify_paths/2 — Class 5: migrations (substrate-independent)" do
    test "new migration → cold on both substrates (REV-B live-repro gap)" do
      file = "priv/repo/migrations/20260522000000_add_thing.exs"

      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths([file], substrate)
        assert {:migration, [^file]} = List.keyfind(reasons, :migration, 0)
      end
    end

    test "edited migration → cold" do
      file = "priv/repo/migrations/99999999999999_smoke.exs"
      assert {:cold, reasons} = Preflight.classify_paths([file], :jail)
      assert {:migration, [^file]} = List.keyfind(reasons, :migration, 0)
    end
  end

  describe "classify_paths/2 — Class 6: nginx + infra/snippets (substrate-independent)" do
    test "infra/nginx.conf → cold on both substrates" do
      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths(["infra/nginx.conf"], substrate)
        assert {:nginx, ["infra/nginx.conf"]} in reasons
      end
    end

    test "infra/snippets/security-headers.conf → cold on both substrates" do
      file = "infra/snippets/security-headers.conf"

      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths([file], substrate)
        assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
      end
    end

    test "infra/snippets/admin/cors.conf → cold (H20 deeper-paths gap)" do
      file = "infra/snippets/admin/cors.conf"
      assert {:cold, reasons} = Preflight.classify_paths([file], :docker)
      assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
    end

    test "infra/freebsd/nginx.conf → cold on both substrates (jail nginx config, parallel to Docker's infra/nginx.conf)" do
      file = "infra/freebsd/nginx.conf"

      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths([file], substrate)
        assert {:nginx, [^file]} = List.keyfind(reasons, :nginx, 0)
      end
    end
  end

  describe "classify_paths/2 — Class 7 (H21+H20): config/*.exs (substrate-independent)" do
    test "config/config.exs → cold on both substrates (H21 SECRET_SIGNING_SALT motivation)" do
      for substrate <- @substrates do
        assert {:cold, reasons} = Preflight.classify_paths(["config/config.exs"], substrate)
        assert {:config, ["config/config.exs"]} in reasons
      end
    end

    test "config/runtime.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/runtime.exs"], :jail)
      assert {:config, ["config/runtime.exs"]} in reasons
    end

    test "config/dev.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/dev.exs"], :docker)
      assert {:config, ["config/dev.exs"]} in reasons
    end

    test "config/prod.exs → cold" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/prod.exs"], :jail)
      assert {:config, ["config/prod.exs"]} in reasons
    end

    test "config/test.exs → cold (test/dev config drift can still affect prod gates)" do
      assert {:cold, reasons} = Preflight.classify_paths(["config/test.exs"], :docker)
      assert {:config, ["config/test.exs"]} in reasons
    end
  end

  describe "classify_paths/2 — HOT path" do
    test "empty diff → hot on both substrates" do
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths([], substrate)
      end
    end

    test "lib/grappa/scrollback.ex (regular module) → hot on both substrates when state-shape check is skipped" do
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths(["lib/grappa/scrollback.ex"], substrate)
      end
    end

    test "cicchetto/src/lib/foo.ts → hot (cic-only is hot)" do
      assert {:hot, []} = Preflight.classify_paths(["cicchetto/src/lib/foo.ts"], :jail)
    end

    test "docs/foo.md → hot" do
      assert {:hot, []} = Preflight.classify_paths(["docs/checkpoints/2026-05-22-cp39.md"], :jail)
    end

    test "test/grappa/foo_test.exs → hot (tests don't ship in prod boot)" do
      assert {:hot, []} = Preflight.classify_paths(["test/grappa/foo_test.exs"], :docker)
    end
  end

  describe "classify_paths/2 — multi-class diff" do
    test "Dockerfile + mix.lock on docker → cold with both reasons" do
      assert {:cold, reasons} = Preflight.classify_paths(["Dockerfile", "mix.lock"], :docker)
      assert {:mix_deps, ["mix.lock"]} in reasons
      assert {:image_substrate, ["Dockerfile"]} in reasons
    end

    test "Dockerfile + mix.lock on jail → cold with ONLY :mix_deps (Dockerfile filtered out)" do
      assert {:cold, reasons} = Preflight.classify_paths(["Dockerfile", "mix.lock"], :jail)
      assert {:mix_deps, ["mix.lock"]} in reasons
      refute List.keyfind(reasons, :image_substrate, 0)
    end

    test "mix.lock + lib/foo.ex → cold (single reason filters out hot file)" do
      assert {:cold, reasons} =
               Preflight.classify_paths(["mix.lock", "lib/grappa/foo.ex"], :jail)

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

    test "extracts an init/1 {:ok, %{...}} map literal (S25 — deploy.sh's promised third shape)" do
      source = """
      defmodule Foo do
        use GenServer

        @impl true
        def init(_opts) do
          {:ok, %{count: 0, peers: %{}}}
        end
      end
      """

      block = Preflight.extract_state_block(source)
      assert block =~ "count: 0"
      assert block =~ "peers:"
    end

    test "an init/1 map is extracted but a same-shaped {:ok, %{...}} in another function is NOT (scoping)" do
      # Session.Server's RPL_LIST parser returns `{:ok, %{name: ...}}`
      # from a NON-init helper — that must never be read as state shape.
      source = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1}}

        defp parse_list_reply(x), do: {:ok, %{name: x, count: 0}}
      end
      """

      block = Preflight.extract_state_block(source)
      assert block =~ "a: 1"
      refute block =~ "name:"
    end
  end

  describe "classify_state_shape/2 — long-lived module state-shape diff" do
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

    test "field added inside an init/1 {:ok, %{...}} map literal → :cold (S25)" do
      # The S25 gap: a module carrying state as a bare init map with
      # NEITHER @type t NOR defstruct. deploy.sh:20-23 promises this
      # shape is detected; before the fix the classifier collected
      # nothing → false :hot → the silent-corruption class.
      from_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1}}
      end
      """

      to_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1, b: 2}}
      end
      """

      assert :cold = Preflight.classify_state_shape(from_src, to_src)
    end

    test "field added inside init/1 {:ok, %{...}, {:continue, _}} → :cold" do
      from_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1}, {:continue, :boot}}
      end
      """

      to_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1, b: 2}, {:continue, :boot}}
      end
      """

      assert :cold = Preflight.classify_state_shape(from_src, to_src)
    end

    test "field added inside a GUARDED init/1 head's {:ok, %{...}} → :cold" do
      # A guarded head quotes as `{:when, _, [{:init, _, [_]}, guard]}`;
      # the classifier must unwrap it or the same false-HOT gap reopens.
      from_src = """
      defmodule Foo do
        def init(opts) when is_list(opts), do: {:ok, %{a: 1}}
      end
      """

      to_src = """
      defmodule Foo do
        def init(opts) when is_list(opts), do: {:ok, %{a: 1, b: 2}}
      end
      """

      assert :cold = Preflight.classify_state_shape(from_src, to_src)
    end

    test "ETS-only init/1 {:ok, %{}} unchanged across revs → :hot (no false-COLD)" do
      # Backoff / NetworkCircuit boot as `{:ok, %{}}` (state in ETS).
      # An empty init map is stable → must stay :hot, or every deploy
      # touching those files forces a needless cold restart.
      source = """
      defmodule Foo do
        def init(_) do
          _ = :ets.new(:t, [:named_table])
          {:ok, %{}}
        end
      end
      """

      assert :hot = Preflight.classify_state_shape(source, source)
    end

    test "a {:ok, %{...}} change OUTSIDE init/1 does not force :cold (scoping)" do
      # Only the init/1 return is state shape. A shape change in an
      # unrelated helper (e.g. an RPL_LIST parser) must stay :hot.
      from_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1}}
        defp parse(x), do: {:ok, %{name: x}}
      end
      """

      to_src = """
      defmodule Foo do
        def init(_), do: {:ok, %{a: 1}}
        defp parse(x), do: {:ok, %{name: x, extra: true}}
      end
      """

      assert :hot = Preflight.classify_state_shape(from_src, to_src)
    end
  end

  describe "classify/5 — full diff classification with injected git" do
    test "no changed paths → :hot" do
      diff_fn = fn _, _ -> [] end
      show_fn = fn _, _ -> nil end
      assert {:hot, []} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
    end

    test "config/runtime.exs touched → :cold with :config reason" do
      diff_fn = fn _, _ -> ["config/runtime.exs"] end
      show_fn = fn _, _ -> nil end
      assert {:cold, reasons} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
      assert {:config, ["config/runtime.exs"]} in reasons
    end

    test "Dockerfile diff → :cold on docker, :hot on jail (the 2026-06-10 incident class)" do
      diff_fn = fn _, _ -> ["Dockerfile"] end
      show_fn = fn _, _ -> nil end

      assert {:cold, reasons} = Preflight.classify("from", "to", :docker, diff_fn, show_fn)
      assert {:image_substrate, ["Dockerfile"]} in reasons

      assert {:hot, []} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
    end

    test "Dockerfile diff on jail does NOT shortcut the state-shape check" do
      # Path-class comes up clean on jail (Dockerfile is docker-only),
      # so a state-shape change riding the same diff must still COLD.
      path = "lib/grappa/session/backoff.ex"
      diff_fn = fn _, _ -> ["Dockerfile", path] end

      show_fn = fn
        "from", ^path ->
          "defmodule Grappa.Session.Backoff do\n  @type t :: %{a: integer()}\nend\n"

        "to", ^path ->
          "defmodule Grappa.Session.Backoff do\n  @type t :: %{a: integer(), b: String.t()}\nend\n"
      end

      assert {:cold, reasons} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
      assert {:state_shape, [^path]} = List.keyfind(reasons, :state_shape, 0)
    end

    test "long-lived module file touched + body change only → :hot" do
      diff_fn = fn _, _ -> ["lib/grappa/session/backoff.ex"] end

      show_fn = fn
        "from", "lib/grappa/session/backoff.ex" ->
          "defmodule Grappa.Session.Backoff do\n  def f, do: :a\nend\n"

        "to", "lib/grappa/session/backoff.ex" ->
          "defmodule Grappa.Session.Backoff do\n  def f, do: :b\nend\n"
      end

      assert {:hot, []} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
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

      assert {:cold, reasons} = Preflight.classify("from", "to", :docker, diff_fn, show_fn)
      assert {:state_shape, [^path]} = List.keyfind(reasons, :state_shape, 0)
    end

    test "non-long-lived module file touched → :hot (no state-shape check)" do
      diff_fn = fn _, _ -> ["lib/grappa/scrollback.ex"] end
      # show_fn would crash if called — scrollback is NOT in the
      # long-lived set, so the classifier must not invoke show_fn.
      show_fn = fn _, _ -> raise "should not be called" end
      assert {:hot, []} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
    end

    test "path-class match short-circuits state-shape check" do
      # mix.lock change already triggers :cold; we should not also
      # invoke show_fn on touched long-lived modules in the same diff.
      diff_fn = fn _, _ -> ["mix.lock", "lib/grappa/session/backoff.ex"] end
      show_fn = fn _, _ -> raise "should not be called when path-class already cold" end
      assert {:cold, reasons} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
      assert {:mix_deps, ["mix.lock"]} in reasons
    end
  end
end
