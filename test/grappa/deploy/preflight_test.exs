defmodule Grappa.Deploy.PreflightTest do
  # async: true — pure logic, no global state.
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Deploy.Preflight

  @substrates [:docker, :jail, :linux]

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

      test "#{file} → hot on linux (linux never reads Docker image files)" do
        assert {:hot, []} = Preflight.classify_paths([unquote(file)], :linux)
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

    test "#{@rc_d} → hot on linux (no rc(8) on a systemd host either)" do
      assert {:hot, []} = Preflight.classify_paths([@rc_d], :linux)
    end
  end

  describe "classify_paths/2 — Class 4c: Linux systemd unit (COLD linux / HOT docker+jail)" do
    @systemd_unit "infra/linux/systemd/grappa.service"

    test "#{@systemd_unit} → cold (:systemd_unit) on linux (unit read only at service (re)start)" do
      assert {:cold, reasons} = Preflight.classify_paths([@systemd_unit], :linux)
      assert {:systemd_unit, [@systemd_unit]} = List.keyfind(reasons, :systemd_unit, 0)
    end

    test "#{@systemd_unit} → hot on docker (no systemd in the container)" do
      assert {:hot, []} = Preflight.classify_paths([@systemd_unit], :docker)
    end

    test "#{@systemd_unit} → hot on jail (FreeBSD has no systemd)" do
      assert {:hot, []} = Preflight.classify_paths([@systemd_unit], :jail)
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

    test "the shared BEAM-wait lib + both entry points → HOT (run from the checkout, never installed out-of-repo)" do
      # #923 deduped the defect-#9 stop/start wait into
      # infra/lib/beam_wait.sh, reached through the jail's
      # jail_beam_wait.sh (rc.d/grappa + deploy.sh's cold path) and the
      # systemd host's grappa_beam_wait.sh (grappa.service ExecStartPre).
      # None of the three is COPIED anywhere: every call site invokes the
      # repo path directly, and jail_install_rcd.sh only re-asserts the
      # exec bit. So a pull is already enough for the NEXT stop or start
      # to run the new bytes, and a restart would pick up nothing a
      # restart is needed for.
      #
      # This is the #646 rule read in the other direction: the
      # source-alias wrapper must be reconciled on EVERY deploy precisely
      # because it is installed to /usr/local/sbin and the checkout is
      # not what runs. These files are what runs.
      for path <- [
            "infra/lib/beam_wait.sh",
            "infra/freebsd/jail_beam_wait.sh",
            "infra/linux/grappa_beam_wait.sh"
          ],
          substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths([path], substrate),
               "expected #{path} to classify HOT on #{substrate}"
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

  describe "classify_paths/2 — Class 6: nginx (:linux-scoped, whole)" do
    # `:linux` is the last deploy substrate that runs an nginx: #485 dropped
    # the Docker container and the bastille jail's nginx was deleted (the m42
    # HOST vhost proxies straight to the jail BEAM on :4000). So the WHOLE
    # class — the config AND the shared snippet prefix — is scoped like its
    # siblings :rc_d / :systemd_unit / :image_substrate.
    @linux_nginx "infra/linux/nginx.conf"
    @snippet "infra/snippets/locations-api.conf"
    @nested_snippet "infra/snippets/admin/cors.conf"
    @no_nginx_substrates [:jail, :docker]

    test "#{@linux_nginx} → cold (:nginx) on linux (the host's own proxy config)" do
      assert {:cold, reasons} = Preflight.classify_paths([@linux_nginx], :linux)
      assert {:nginx, [@linux_nginx]} = List.keyfind(reasons, :nginx, 0)
    end

    test "#{@snippet} → cold (:nginx) on linux (its nginx includes it)" do
      assert {:cold, reasons} = Preflight.classify_paths([@snippet], :linux)
      assert {:nginx, [@snippet]} = List.keyfind(reasons, :nginx, 0)
    end

    test "#{@nested_snippet} → cold on linux (H20 deeper-paths gap: the whole prefix)" do
      assert {:cold, reasons} = Preflight.classify_paths([@nested_snippet], :linux)
      assert {:nginx, [@nested_snippet]} = List.keyfind(reasons, :nginx, 0)
    end

    # The load-bearing half of the jail-nginx removal. The snippet used to be
    # COLD on EVERY substrate ("every surviving nginx includes it"), so left
    # alone it would now drop every live IRC session on m42 prod to install a
    # file the jail no longer has an nginx to read — the #923 failure class,
    # and the 2026-06-10 Dockerfile-COLD incident before it.
    test "no nginx path is COLD on a substrate that runs no nginx" do
      for substrate <- @no_nginx_substrates,
          path <- [@linux_nginx, @snippet, @nested_snippet] do
        assert {:hot, []} = Preflight.classify_paths([path], substrate),
               "#{path} must be HOT on #{substrate}: that substrate runs no nginx to reload"
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

  describe "classify_paths/2 — Class 8: VERSION (COLD on the release substrates)" do
    # #1287, repro'd in production 2026-08-13 on a v1.0.0 → v1.1.0 deploy:
    # the bump moves the release's lib directory to `lib/grappa-<new>/ebin`
    # while the running node keeps resolving `:code.lib_dir(:grappa)` to its
    # BOOT directory, so the hot reload diffs a stale tree against itself and
    # answers `{"reloaded":[]}` — a success shape it has no way to distinguish
    # from "nothing to do". REVERSES the #652 pin that used to live in the HOT
    # describe below.
    test "VERSION → cold (:version) on jail (mix release, versioned lib dir)" do
      assert {:cold, reasons} = Preflight.classify_paths(["VERSION"], :jail)
      assert {:version, ["VERSION"]} in reasons
    end

    test "VERSION → cold (:version) on linux (mix release, versioned lib dir)" do
      assert {:cold, reasons} = Preflight.classify_paths(["VERSION"], :linux)
      assert {:version, ["VERSION"]} in reasons
    end

    test "VERSION → hot on docker (mix phx.server, unversioned _build lib dir)" do
      # The container execs `mix phx.server` over a bind-mounted tree
      # (bin/start.sh), so `:code.lib_dir(:grappa)` is `_build/<env>/lib/grappa`
      # — no vsn in the path, and the reload sees the fresh beams. COLDing
      # docker for a file its boot layout is immune to is the needless-restart
      # class the substrate argument exists to prevent (moduledoc, 2026-06-10).
      assert {:hot, []} = Preflight.classify_paths(["VERSION"], :docker)
    end

    test "the real bump-commit shape (VERSION + version.ex) → cold on linux" do
      assert {:cold, reasons} =
               Preflight.classify_paths(["VERSION", "lib/grappa/version.ex"], :linux)

      assert {:version, ["VERSION"]} in reasons
    end

    test "a VERSION-named file elsewhere in the tree → hot (exact repo-root match)" do
      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify_paths(["cicchetto/VERSION"], substrate)
      end
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

  describe "classify_migration/1 — expand (HOT) allowlist" do
    test "additive column with no opts — nullable by Ecto default (the #618 instance)" do
      # Verbatim from 20260805100000_add_old_nick_to_session_log_events,
      # whose moduledoc claims HOT while the pre-#41 classifier said COLD.
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:session_log_events) do
                       add :old_nick, :string
                     end
                   end
                 """)
               )
    end

    test "add null: true (the #41 canonical case: source_address)" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:network_servers) do
                       add :source_address, :string, null: true
                     end
                   end
                 """)
               )
    end

    test "add null: false WITH a default — an old-code insert omitting it still lands" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:users) do
                       add :is_admin, :boolean, default: false, null: false
                     end
                   end
                 """)
               )
    end

    test "add with only a default:" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:t) do
                       add :c, :integer, default: 0
                     end
                   end
                 """)
               )
    end

    test "array type is a literal type" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:t) do
                       add :c, {:array, :string}
                     end
                   end
                 """)
               )
    end

    test "add_if_not_exists follows the same nullability rule" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:t) do
                       add_if_not_exists :c, :string
                     end
                   end
                 """)
               )
    end

    test "create table with a block — contents irrelevant, incl. references + timestamps" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create table(:sessions, primary_key: false) do
                       add :id, :binary_id, primary_key: true
                       add :user_id, references(:users, type: :binary_id), null: false
                       timestamps(type: :utc_datetime_usec)
                     end
                   end
                 """)
               )
    end

    test "create_if_not_exists table with a block" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create_if_not_exists table(:t) do
                       add :c, :string
                     end
                   end
                 """)
               )
    end

    test "plain index, 2-arg" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create index(:messages, [:network_id, :channel])
                   end
                 """)
               )
    end

    test "plain partial index with where:/name: opts" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create index(:network_credentials, [:connection_state],
                              where: "connection_state = 'connected'",
                              name: :nc_connected_index
                            )
                   end
                 """)
               )
    end

    test "index over SQL column expressions (strings, not atoms)" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create index(:messages, ["user_id", "COALESCE(dm_with, channel)"],
                              name: :messages_archive_user_idx
                            )
                   end
                 """)
               )
    end

    test "unique_index on a table THIS body created — zero rows, no loaded schema" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create table(:themes) do
                       add :name, :string, null: false
                     end

                     create unique_index(:themes, [:name])
                   end
                 """)
               )
    end

    test "check constraint on a table THIS body created" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create table(:t) do
                       add :n, :integer
                     end

                     create constraint(:t, :n_positive, check: "n > 0")
                   end
                 """)
               )
    end

    test "def up/0 is classified like def change/0" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def up do
                     alter table(:t) do
                       add :c, :string
                     end
                   end
                 """)
               )
    end

    test "a CONTRACT down/0 does not cold-trip an expand up/0 — down never runs on deploy" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def up do
                     alter table(:t) do
                       add :c, :string
                     end
                   end

                   def down do
                     alter table(:t) do
                       remove :c
                     end
                   end
                 """)
               )
    end

    test "several expand statements in one body" do
      assert :hot =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     alter table(:network_credentials) do
                       add :ident, :string, null: true
                     end

                     alter table(:visitors) do
                       add :ident, :string, null: true
                       add :realname, :string, null: true
                     end

                     create index(:visitors, [:ident])
                   end
                 """)
               )
    end
  end

  describe "classify_migration/1 — contract + unprovable (COLD)" do
    for {label, body} <- [
          {"remove", "alter table(:t) do\n  remove :c\nend"},
          {"remove_if_exists", "alter table(:t) do\n  remove_if_exists :c, :string\nend"},
          {"modify", "alter table(:t) do\n  modify :c, :text\nend"},
          {"modify tightening to null: false", "alter table(:t) do\n  modify :c, :text, null: false\nend"},
          {"rename column", "rename table(:t), :a, to: :b"},
          {"rename table", "rename table(:t), to: table(:u)"},
          {"drop", "drop table(:t)"},
          {"drop_if_exists", "drop_if_exists index(:t, [:c])"},
          {"raw execute", ~s|execute("ALTER TABLE t ADD COLUMN c TEXT")|},
          {"add null: false with no default", "alter table(:t) do\n  add :c, :string, null: false\nend"},
          {"unique_index on a pre-existing table", "create unique_index(:users, [:name])"},
          {"constraint on a pre-existing table", ~s|create constraint(:t, :n_positive, check: "n > 0")|},
          {"index with unique: true", "create index(:t, [:c], unique: true)"},
          {"add of a references/0 type", "alter table(:t) do\n  add :u, references(:users)\nend"},
          {"timestamps inside alter (two NOT NULL columns)",
           "alter table(:t) do\n  timestamps(type: :utc_datetime_usec)\nend"},
          {"flush", "flush()"},
          {"conditional", "if true do\n  create index(:t, [:c])\nend"},
          {"call into a local helper", "backfill()"},
          {"dynamic column name", "alter table(:t) do\n  add col, :string\nend"},
          {"dynamic type", "alter table(:t) do\n  add :c, type\nend"},
          {"non-literal null: value", "alter table(:t) do\n  add :c, :string, null: nullable?\nend"},
          {"repo() escape hatch", ~s|repo().query!("PRAGMA writable_schema = ON")|},
          {"expand statement followed by a contract one",
           "alter table(:t) do\n  add :c, :string\nend\n\ndrop index(:t, [:d])"},
          {"expand and contract inside ONE alter block", "alter table(:t) do\n  add :c, :string\n  remove :d\nend"}
        ] do
      test "#{label} → :cold" do
        assert :cold =
                 Preflight.classify_migration(migration("def change do\n#{unquote(body)}\nend"))
      end
    end

    test "create_if_not_exists table does NOT make a unique_index provable" do
      # The table may already exist, populated, from an earlier partial run.
      assert :cold =
               Preflight.classify_migration(
                 migration("""
                   def change do
                     create_if_not_exists table(:t) do
                       add :name, :string
                     end

                     create unique_index(:t, [:name])
                   end
                 """)
               )
    end

    test "@disable_ddl_transaction opts out of the rollback the abort contract needs" do
      assert :cold =
               Preflight.classify_migration("""
               defmodule Grappa.Repo.Migrations.Probe do
                 use Ecto.Migration

                 @disable_ddl_transaction true

                 def change do
                   alter table(:t) do
                     add :c, :string
                   end
                 end
               end
               """)
    end

    test "no change/0 and no up/0 (down-only module)" do
      assert :cold =
               Preflight.classify_migration(
                 migration("""
                   def down do
                     drop table(:t)
                   end
                 """)
               )
    end

    test "def change, do: :ok — a literal body is provably harmless yet still COLD" do
      # Deliberate: the allowlist enumerates OPS. "This statement is not
      # an op at all" is a second, unrelated proof obligation, and this
      # real 2026-05-04 migration is already applied everywhere.
      assert :cold = Preflight.classify_migration(migration("def change, do: :ok"))
    end

    test "unparseable source" do
      assert :cold = Preflight.classify_migration("defmodule Broken do\n  def change do\n")
    end

    test "empty source" do
      assert :cold = Preflight.classify_migration("")
    end
  end

  describe "classify_migration/1 — property: one unprovable op poisons the body" do
    @hot_ops [
      "create index(:t, [:c])",
      "create table(:fresh) do\n  add :c, :string\nend",
      "alter table(:t) do\n  add :c, :string\nend",
      "alter table(:t) do\n  add :d, :integer, null: false, default: 0\nend"
    ]
    @cold_ops [
      "alter table(:t) do\n  remove :c\nend",
      "alter table(:t) do\n  modify :c, :text\nend",
      ~s|execute("VACUUM")|,
      "drop table(:t)",
      "create unique_index(:t, [:c])",
      "alter table(:t) do\n  add :e, :string, null: false\nend"
    ]

    property "a body of only allowlisted ops is :hot" do
      check all(ops <- list_of(member_of(@hot_ops), min_length: 1, max_length: 5)) do
        assert :cold != Preflight.classify_migration(body_of(ops))
      end
    end

    property "adding ANY non-allowlisted op to an all-expand body flips it to :cold" do
      check all(
              hot <- list_of(member_of(@hot_ops), max_length: 4),
              cold <- member_of(@cold_ops),
              at <- integer(0..length(hot))
            ) do
        ops = List.insert_at(hot, at, cold)
        assert :cold = Preflight.classify_migration(body_of(ops))
      end
    end
  end

  describe "classify_migration/1 — the real migration history" do
    # #41 asks for this explicitly: validate against every migration in
    # the repo BEFORE wiring the classifier into the deploy path. The
    # list is PINNED, so a future classifier edit that silently flips a
    # real migration's class fails here instead of on m42.
    @migrations_glob "priv/repo/migrations/*.exs"
    @expected_hot ~w(
      20260425000000_init
      20260426000000_create_users
      20260426000001_create_sessions
      20260502073632_create_visitors
      20260502080806_create_visitor_channels
      20260503090000_add_client_id_to_sessions
      20260503090001_add_admission_caps_to_networks
      20260504140000_create_user_settings
      20260510170000_add_last_joined_channels_to_network_credentials
      20260512083037_network_credentials_connection_state_partial_index
      20260514114123_create_push_subscriptions
      20260516030833_add_is_admin_to_users
      20260522073826_add_archive_covering_indexes
      20260603174206_add_source_address_to_servers
      20260628105147_create_network_featured_channels
      20260709120000_recreate_read_cursors_last_read_message_id_index
      20260709120100_add_messages_network_id_index
      20260711120000_add_ident_to_credentials_and_ident_realname_to_visitors
      20260711124000_add_visitor_enabled_to_networks
      20260712120000_add_visitor_autoconnect_to_networks
      20260715120000_create_session_log_events
      20260715120100_create_admin_events
      20260717120000_create_themes
      20260718130000_add_author_nick_to_themes
      20260722202612_add_messages_id_cursor_composite_indexes
      20260724120000_add_services_flavor_to_networks
      20260725130000_add_perform_list_to_network_credentials
      20260726120000_add_uploads_user_id_cascade_fk_index
      20260726130000_add_incognito_to_visitors
      20260726140000_add_away_state_to_network_credentials
      20260728120000_add_nickserv_pass_to_network_credentials
      20260802190000_add_user_totp
      20260805100000_add_old_nick_to_session_log_events
      20260810120000_add_client_tokens_to_sessions
      20260812220753_add_charset_to_uploads
      20260813074128_add_provider_to_push_subscriptions
      20260820174126_add_label_to_push_subscriptions
    )

    test "every migration on disk classifies, and the HOT set is exactly the pinned one" do
      files = Path.wildcard(@migrations_glob)
      assert length(files) > 50, "expected the real migrations dir, found #{length(files)} files"

      hot =
        for path <- files,
            Preflight.classify_migration(File.read!(path)) == :hot,
            do: Path.basename(path, ".exs")

      assert Enum.sort(hot) == Enum.sort(@expected_hot)
    end

    test "the #618 additive-nullable migration is HOT — #41's thesis, on a real file" do
      source = File.read!("priv/repo/migrations/20260805100000_add_old_nick_to_session_log_events.exs")
      assert :hot = Preflight.classify_migration(source)
    end

    test "an index migration whose down/0 drops it is HOT — down never runs on deploy" do
      # The measured surprise of the first real run: four migrations
      # classify HOT that a whole-file grep for `drop` calls contract.
      # Their up/0 is `create index` and nothing else; the drop lives in
      # down/0, which `Ecto.Migrator.run(_, :up, _)` never reaches.
      source =
        File.read!("priv/repo/migrations/20260726120000_add_uploads_user_id_cascade_fk_index.exs")

      assert :hot = Preflight.classify_migration(source)
    end

    test "the writable_schema NOT NULL relaxation stays COLD" do
      source = File.read!("priv/repo/migrations/20260515111331_visitors_expires_at_nullable.exs")
      assert :cold = Preflight.classify_migration(source)
    end
  end

  describe "classify/5 — migration expand/contract enters the verdict" do
    @expand "priv/repo/migrations/20260901000000_add_thing.exs"
    @contract "priv/repo/migrations/20260901000001_drop_thing.exs"

    test "an all-expand migration no longer forces COLD" do
      diff_fn = fn _, _ -> [@expand] end
      show_fn = fn "to", @expand -> expand_source() end

      for substrate <- @substrates do
        assert {:hot, []} = Preflight.classify("from", "to", substrate, diff_fn, show_fn)
      end
    end

    test "a contract migration still forces COLD, and is named" do
      diff_fn = fn _, _ -> [@contract] end
      show_fn = fn "to", @contract -> contract_source() end

      assert {:cold, reasons} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
      assert {:migration, [@contract]} = List.keyfind(reasons, :migration, 0)
    end

    test "mixed diff names ONLY the contract migration" do
      diff_fn = fn _, _ -> [@expand, @contract] end

      show_fn = fn
        "to", @expand -> expand_source()
        "to", @contract -> contract_source()
      end

      assert {:cold, reasons} = Preflight.classify("from", "to", :docker, diff_fn, show_fn)
      assert {:migration, [@contract]} = List.keyfind(reasons, :migration, 0)
    end

    test "a migration whose source cannot be read is COLD (deleted file, unknown rev)" do
      diff_fn = fn _, _ -> [@expand] end
      show_fn = fn "to", @expand -> nil end

      assert {:cold, reasons} = Preflight.classify("from", "to", :linux, diff_fn, show_fn)
      assert {:migration, [@expand]} = List.keyfind(reasons, :migration, 0)
    end

    test "the source is read at the TARGET rev, never the base" do
      # A migration ADDED in this range does not exist at `from`; asking
      # for it there would be nil → a permanent false-COLD.
      diff_fn = fn _, _ -> [@expand] end

      show_fn = fn
        "to", @expand -> expand_source()
        "from", @expand -> raise "classifier must not read the base rev"
      end

      assert {:hot, []} = Preflight.classify("from", "to", :jail, diff_fn, show_fn)
    end
  end

  # A minimal well-formed migration module wrapping `body`.
  defp migration(body) do
    """
    defmodule Grappa.Repo.Migrations.Probe do
      use Ecto.Migration

    #{body}
    end
    """
  end

  defp body_of(ops), do: migration("def change do\n#{Enum.join(ops, "\n\n")}\nend")

  defp expand_source do
    migration("def change do\n  alter table(:t) do\n    add :c, :string\n  end\nend")
  end

  defp contract_source do
    migration("def change do\n  alter table(:t) do\n    remove :c\n  end\nend")
  end
end
