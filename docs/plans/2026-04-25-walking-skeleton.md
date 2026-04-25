# grappa walking-skeleton — Phase 1 Implementation Plan (Elixir/OTP + Phoenix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user grappa server that connects to one upstream IRC network, persists scrollback to sqlite, and exposes the minimum REST + Phoenix Channels surface the cicchetto PWA will need for a round-trip `PRIVMSG`.

**Architecture:** Elixir application with one supervised `Grappa.Session` GenServer per `(user, network)`, registered in a `Registry` and supervised by a `DynamicSupervisor`. Upstream IRC is owned by `Grappa.IRC.Client` (our own minimal client — pure SASL + `CAP LS`, no IRCv3 extensions assumed). Scrollback in `Ecto`-managed sqlite via `ecto_sqlite3`, with monotonic `server_time`-indexed rows so a future `CHATHISTORY` facade is a mechanical translation rather than a schema redesign. Streaming surface is **Phoenix Channels** — multiplexed pub/sub over a single WebSocket per browser tab, topics like `grappa:network:{net}/channel:{chan}`. Auth is deferred to Phase 2 — this phase hardcodes one user + one network from a TOML config file.

**Tech Stack:** Elixir 1.19 + Erlang/OTP 28. Deps: `phoenix` 1.8, `phoenix_pubsub` 2, `ecto_sql` 3, `ecto_sqlite3` 0.22, `jason` 1, `toml` 0.7, `req` 0.5, `bandit` 1 (HTTP server). Test deps: `stream_data` 1.3, `mox` 1.2, `bypass` 2.1, `ex_machina` 2.8. Tooling: `credo` 1.7, `dialyxir` 1.4, `sobelow` 0.14, `mix_audit` 2.1, `excoveralls` 0.18, `doctor` 0.22, `boundary` 0.10, `mix_test_watch` 1.4, `recon` 2.5, `observer_cli` 1.8.

---

## Scope

**In scope (this plan):**
- Single-binary `grappa` Elixir application (no umbrella, single mix project).
- TOML config for one hardcoded user + one upstream network (host, port, TLS on/off, nick, optional SASL password, autojoin channels).
- One `Grappa.Session` GenServer per `(user, network)` under `Grappa.SessionSupervisor` (`DynamicSupervisor`), registered in `Grappa.SessionRegistry`.
- Own `Grappa.IRC.Client` GenServer owning the TCP/TLS socket + IRC line parser + `CAP LS` + SASL PLAIN handshake + `JOIN` autojoin.
- sqlite-backed scrollback via Ecto, schema supporting paginated reads keyed by `(network_id, channel, server_time DESC)`.
- REST: `GET /networks`, `GET /networks/:net/channels`, `POST /networks/:net/channels` (JOIN), `DELETE /networks/:net/channels/:chan` (PART), `GET /networks/:net/channels/:chan/messages?before=<ts>&limit=N`, `POST /networks/:net/channels/:chan/messages`.
- Phoenix Channels: `/socket/websocket` endpoint, `grappa:network:{net}/channel:{chan}` topic delivering typed JSON events (`message`, `join`, `part`, `quit`, `nick`).
- Logger structured logs to stderr.
- Test coverage: scrollback pagination, REST controllers (with sandboxed Repo), event broadcast via PubSub, IRC parser, Channel subscribe + receive.
- All CI gates green: `mix format --check-formatted`, `mix credo --strict`, `mix dialyzer`, `mix sobelow`, `mix deps.audit`, `mix doctor`, `mix test --warnings-as-errors --cover`, `mix docs`.

**Out of scope (deferred to later phases):**
- Authentication (any). Phase 2.
- NickServ registration proxy. Phase 2.
- Multi-user isolation. Phase 2.
- The cicchetto PWA. Phase 3.
- The IRCv3 listener facade. Phase 6.
- Reconnect/backoff hardening beyond `:transient` supervisor restart. Phase 5.
- Scrollback eviction policy. Phase 5.

---

## File Structure

```
grappa-irc/
├── mix.exs                          # project + deps + tool config
├── mix.lock
├── .tool-versions                   # elixir 1.19.5, erlang 28.5
├── .formatter.exs
├── .credo.exs
├── .gitignore                       # _build, deps, cover, *.beam, etc.
├── config/
│   ├── config.exs                   # compile-time, all envs
│   ├── dev.exs
│   ├── test.exs
│   ├── runtime.exs                  # runtime: reads env vars + TOML config path
│   └── prod.exs
├── lib/
│   ├── grappa.ex                    # @moduledoc + version() helper
│   ├── grappa/
│   │   ├── application.ex           # supervision tree
│   │   ├── config.ex                # TOML loader (Grappa.Config)
│   │   ├── repo.ex                  # Ecto.Repo
│   │   ├── scrollback.ex            # context: insert/2 + fetch/4
│   │   ├── scrollback/
│   │   │   └── message.ex           # Ecto schema
│   │   ├── irc/
│   │   │   ├── parser.ex            # binary pattern matching → %Grappa.IRC.Message{}
│   │   │   ├── message.ex           # struct
│   │   │   └── client.ex            # GenServer owning :gen_tcp / :ssl
│   │   └── session/
│   │       ├── supervisor.ex        # DynamicSupervisor + Registry
│   │       └── server.ex            # Grappa.Session.Server GenServer
│   ├── grappa_web.ex
│   └── grappa_web/
│       ├── endpoint.ex              # Phoenix.Endpoint
│       ├── router.ex                # Phoenix.Router
│       ├── controllers/
│       │   ├── fallback_controller.ex
│       │   ├── messages_controller.ex
│       │   ├── channels_controller.ex
│       │   └── networks_controller.ex
│       └── channels/
│           ├── user_socket.ex
│           └── grappa_channel.ex
├── priv/
│   └── repo/
│       └── migrations/
│           └── 20260425000000_init.exs
└── test/
    ├── test_helper.exs
    ├── support/
    │   ├── data_case.ex
    │   ├── conn_case.ex
    │   ├── channel_case.ex
    │   └── irc_server.ex            # in-process fake IRC server for session tests
    ├── grappa/
    │   ├── config_test.exs
    │   ├── scrollback_test.exs
    │   ├── irc/
    │   │   └── parser_test.exs
    │   └── session/
    │       └── server_test.exs
    └── grappa_web/
        ├── controllers/
        │   ├── messages_controller_test.exs
        │   └── channels_controller_test.exs
        └── channels/
            └── grappa_channel_test.exs
```

Rationale for the split:

- **Contexts at top of `lib/grappa/`** (`scrollback.ex`, plus `irc/`, `session/`). Each context exposes a public API; internal modules are dot-namespaced under it. Dialyzer + Boundary enforce inter-context boundaries.
- **`grappa_web/`** is the Phoenix layer. Controllers, endpoint, router, channels — all the HTTP+WS surface. Domain logic lives in `grappa/`.
- **`test/support/`** holds shared test helpers including an in-process fake IRC server used by Task 8.
- **One migration file** for Phase 1 — schema is small enough to fit one `up`/`down`. Add migrations cumulatively from Phase 2.

---

## Task 0: Repository bootstrap (mix project + tooling)

**Files:**
- Create: `mix.exs`
- Create: `.tool-versions`
- Create: `.formatter.exs`
- Create: `.credo.exs`
- Create: `.gitignore` (replaces existing Rust-flavoured one)
- Create: `config/config.exs`, `config/dev.exs`, `config/test.exs`, `config/runtime.exs`, `config/prod.exs`
- Create: `lib/grappa.ex`
- Create: `lib/grappa/application.ex` (skeleton — children populated incrementally)
- Create: `test/test_helper.exs`

This task gives us a compiling-but-empty Elixir/Phoenix application: `mix compile` clean, `mix test` runs zero tests, `mix dialyzer` runs against an empty PLT. Each subsequent task adds one capability with a failing test first.

- [ ] **Step 1: Pin runtime versions in `.tool-versions`**

```
elixir 1.19.5-otp-28
erlang 28.5
```

(asdf / mise / rtx all read this format. Document the choice in CLAUDE.md.)

- [ ] **Step 2: Write `mix.exs` with all deps**

```elixir
defmodule Grappa.MixProject do
  use Mix.Project

  def project do
    [
      app: :grappa,
      version: "0.0.1",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      test_coverage: [tool: ExCoveralls],
      preferred_cli_env: [
        coveralls: :test,
        "coveralls.detail": :test,
        "coveralls.html": :test,
        "coveralls.json": :test
      ],
      dialyzer: [
        plt_add_apps: [:ex_unit, :mix],
        flags: [:error_handling, :extra_return, :missing_return, :underspecs, :unmatched_returns]
      ],
      docs: [main: "Grappa", extras: ["README.md", "docs/DESIGN_NOTES.md"]],
      sobelow: [verbose: true, exit: "Medium"],
      boundary: [default: [check: [in: true, out: true]]]
    ]
  end

  def application do
    [
      mod: {Grappa.Application, []},
      extra_applications: [:logger, :runtime_tools, :ssl, :crypto]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # Runtime
      {:phoenix, "~> 1.8.0"},
      {:phoenix_pubsub, "~> 2.1"},
      {:bandit, "~> 1.6"},
      {:plug, "~> 1.16"},
      {:ecto_sql, "~> 3.12"},
      {:ecto_sqlite3, "~> 0.22"},
      {:jason, "~> 1.4"},
      {:toml, "~> 0.7"},
      {:req, "~> 0.5"},
      {:argon2_elixir, "~> 4.1"},
      {:telemetry, "~> 1.3"},
      {:telemetry_metrics, "~> 1.0"},
      {:recon, "~> 2.5"},
      # Tooling
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:sobelow, "~> 0.14", only: [:dev, :test], runtime: false},
      {:mix_audit, "~> 2.1", only: [:dev, :test], runtime: false},
      {:doctor, "~> 0.22", only: [:dev, :test], runtime: false},
      {:boundary, "~> 0.10", runtime: false},
      {:ex_doc, "~> 0.34", only: [:dev], runtime: false},
      {:mix_test_watch, "~> 1.4", only: [:dev, :test], runtime: false},
      # Test
      {:stream_data, "~> 1.3", only: [:dev, :test]},
      {:mox, "~> 1.2", only: :test},
      {:bypass, "~> 2.1", only: :test},
      {:ex_machina, "~> 2.8", only: :test},
      {:excoveralls, "~> 0.18", only: :test},
      {:observer_cli, "~> 1.8", only: [:dev]}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.setup"],
      "ecto.setup": ["ecto.create", "ecto.migrate"],
      "ecto.reset": ["ecto.drop", "ecto.setup"],
      test: ["ecto.create --quiet", "ecto.migrate --quiet", "test"],
      "ci.check": [
        "format --check-formatted",
        "credo --strict",
        "deps.audit",
        "hex.audit",
        "sobelow --config --exit Medium",
        "doctor",
        "test --warnings-as-errors --cover",
        "dialyzer",
        "docs"
      ]
    ]
  end
end
```

- [ ] **Step 3: Write `.formatter.exs`**

```elixir
[
  import_deps: [:ecto, :ecto_sql, :phoenix],
  subdirectories: ["priv/*/migrations"],
  plugins: [Phoenix.LiveView.HTMLFormatter],
  inputs: ["*.{heex,ex,exs}", "{config,lib,test}/**/*.{heex,ex,exs}", "priv/*/seeds.exs"]
]
```

- [ ] **Step 4: Write `.credo.exs`**

Strict mode, `@spec` on every public function, no skipped checks except where explicitly justified per file.

```elixir
%{
  configs: [
    %{
      name: "default",
      files: %{
        included: ["lib/", "src/", "test/", "web/", "apps/", "config/"],
        excluded: [~r"/_build/", ~r"/deps/", ~r"/node_modules/"]
      },
      strict: true,
      color: true,
      checks: %{
        enabled: [
          {Credo.Check.Consistency.ExceptionNames, []},
          {Credo.Check.Consistency.LineEndings, []},
          {Credo.Check.Consistency.ParameterPatternMatching, []},
          {Credo.Check.Consistency.SpaceAroundOperators, []},
          {Credo.Check.Consistency.SpaceInParentheses, []},
          {Credo.Check.Consistency.TabsOrSpaces, []},
          {Credo.Check.Design.AliasUsage, [priority: :low, if_nested_deeper_than: 2]},
          {Credo.Check.Design.TagTODO, [exit_status: 0]},
          {Credo.Check.Readability.AliasOrder, []},
          {Credo.Check.Readability.FunctionNames, []},
          {Credo.Check.Readability.LargeNumbers, []},
          {Credo.Check.Readability.MaxLineLength, [priority: :low, max_length: 120]},
          {Credo.Check.Readability.ModuleAttributeNames, []},
          {Credo.Check.Readability.ModuleDoc, []},
          {Credo.Check.Readability.ModuleNames, []},
          {Credo.Check.Readability.PredicateFunctionNames, []},
          {Credo.Check.Readability.PreferImplicitTry, []},
          {Credo.Check.Readability.RedundantBlankLines, []},
          {Credo.Check.Readability.Semicolons, []},
          {Credo.Check.Readability.SpaceAfterCommas, []},
          {Credo.Check.Readability.StringSigils, []},
          {Credo.Check.Readability.TrailingBlankLine, []},
          {Credo.Check.Readability.TrailingWhiteSpace, []},
          {Credo.Check.Readability.UnnecessaryAliasExpansion, []},
          {Credo.Check.Readability.VariableNames, []},
          {Credo.Check.Readability.Specs, [priority: :high]},
          {Credo.Check.Refactor.CyclomaticComplexity, []},
          {Credo.Check.Refactor.FunctionArity, []},
          {Credo.Check.Refactor.LongQuoteBlocks, []},
          {Credo.Check.Refactor.MatchInCondition, []},
          {Credo.Check.Refactor.NegatedConditionsInUnless, []},
          {Credo.Check.Refactor.NegatedConditionsWithElse, []},
          {Credo.Check.Refactor.Nesting, []},
          {Credo.Check.Refactor.UnlessWithElse, []},
          {Credo.Check.Refactor.WithClauses, []},
          {Credo.Check.Warning.BoolOperationOnSameValues, []},
          {Credo.Check.Warning.ExpensiveEmptyEnumCheck, []},
          {Credo.Check.Warning.IExPry, []},
          {Credo.Check.Warning.IoInspect, []},
          {Credo.Check.Warning.OperationOnSameValues, []},
          {Credo.Check.Warning.OperationWithConstantResult, []},
          {Credo.Check.Warning.RaiseInsideRescue, []},
          {Credo.Check.Warning.UnusedEnumOperation, []},
          {Credo.Check.Warning.UnusedFileOperation, []},
          {Credo.Check.Warning.UnusedKeywordOperation, []},
          {Credo.Check.Warning.UnusedListOperation, []},
          {Credo.Check.Warning.UnusedPathOperation, []},
          {Credo.Check.Warning.UnusedRegexOperation, []},
          {Credo.Check.Warning.UnusedStringOperation, []},
          {Credo.Check.Warning.UnusedTupleOperation, []}
        ]
      }
    }
  ]
}
```

The `Credo.Check.Readability.Specs` rule enforces `@spec` on every public function. This is **the** signal that compensates for Dialyzer's gradual nature.

- [ ] **Step 5: Replace `.gitignore`**

```
# Elixir / Erlang
/_build/
/cover/
/deps/
/doc/
/.fetch
erl_crash.dump
*.ez
*.beam
.elixir_ls/
/.dialyxir_*
*.plt

# Releases
/grappa-*.tar
/release/

# Test coverage
/cover/
/coverage/

# Mix-generated
/*.zip
*.zip

# Local config / DB
/grappa.toml
/grappa_dev.db
/grappa_dev.db-journal
/grappa_test.db
/grappa_test.db-journal
*.db-shm
*.db-wal

# Node / PWA (cicchetto, future)
/node_modules/
/dist/
/.vite/
/.svelte-kit/
*.log

# OS
.DS_Store
Thumbs.db

# Editors
.vscode/
.idea/
*.swp
*~

# Local env
.env
.env.local
*.local
```

- [ ] **Step 6: Write `lib/grappa.ex`**

```elixir
defmodule Grappa do
  @moduledoc """
  grappa — an always-on IRC bouncer with REST + Phoenix Channels.

  See `README.md` and `docs/DESIGN_NOTES.md` for the architecture.
  """

  @doc "Returns the current grappa version (from mix.exs)."
  @spec version() :: String.t()
  def version, do: Application.spec(:grappa, :vsn) |> to_string()
end
```

- [ ] **Step 7: Write `lib/grappa/application.ex` (initial skeleton)**

```elixir
defmodule Grappa.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      Grappa.Repo,
      {Phoenix.PubSub, name: Grappa.PubSub},
      {Registry, keys: :unique, name: Grappa.SessionRegistry},
      {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one},
      GrappaWeb.Endpoint
      # Grappa.Bootstrap added in Task 8
    ]

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
```

(Children referencing modules that don't exist yet — `Grappa.Repo`, `GrappaWeb.Endpoint` — will compile-fail. Task 2 adds the Repo; Task 4 adds the Endpoint. For now, **comment out the missing children** and re-enable as each task lands.)

For Step 7 specifically, write the skeleton with both `Grappa.Repo` and `GrappaWeb.Endpoint` commented out:

```elixir
children = [
  # Grappa.Repo,                                                     # Task 2
  {Phoenix.PubSub, name: Grappa.PubSub},
  {Registry, keys: :unique, name: Grappa.SessionRegistry},
  {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one}
  # GrappaWeb.Endpoint                                               # Task 4
  # Grappa.Bootstrap                                                 # Task 8
]
```

Each subsequent task's first step is "uncomment the relevant child."

- [ ] **Step 8: Write `config/config.exs`**

```elixir
import Config

config :grappa,
  ecto_repos: [Grappa.Repo],
  generators: [timestamp_type: :utc_datetime_usec, binary_id: true]

config :grappa, Grappa.Repo,
  adapter: Ecto.Adapters.SQLite3,
  database: "grappa_dev.db"

# Phoenix endpoint config — actual values set per-env in dev.exs / prod.exs
config :grappa, GrappaWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: GrappaWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Grappa.PubSub

config :phoenix, :json_library, Jason

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id, :user, :network, :channel]

import_config "#{config_env()}.exs"
```

- [ ] **Step 9: Write `config/dev.exs`**

```elixir
import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../grappa_dev.db", __DIR__),
  pool_size: 5,
  show_sensitive_data_on_connection_error: true

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  check_origin: false,
  debug_errors: true,
  code_reloader: true,
  secret_key_base: "dev-secret-replace-in-prod-1234567890123456789012345678901234567890"

config :grappa, dev_routes: true

config :logger, :console, format: "[$level] $message\n"
config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
```

- [ ] **Step 10: Write `config/test.exs`**

```elixir
import Config

config :grappa, Grappa.Repo,
  database: Path.expand("../grappa_test.db#{System.get_env("MIX_TEST_PARTITION")}", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "test-secret-1234567890123456789012345678901234567890123456789012345678",
  server: false

config :logger, level: :warning
config :phoenix, :plug_init_mode, :runtime
config :phoenix, :json_library, Jason
```

- [ ] **Step 11: Write `config/runtime.exs`**

```elixir
import Config

# This file is loaded at runtime in releases (and after compile-time config in dev/test).
# It's the right place to read environment variables.

if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise "DATABASE_PATH must be set"

  config :grappa, Grappa.Repo,
    database: database_path,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5")

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE must be set (generate with `mix phx.gen.secret`)"

  port = String.to_integer(System.get_env("PORT") || "4000")

  config :grappa, GrappaWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: port],
    secret_key_base: secret_key_base,
    server: true

  # TOML config path — read by Grappa.Config at startup
  config :grappa, :config_path, System.get_env("GRAPPA_CONFIG") || "/etc/grappa/grappa.toml"
end

# Dev/test default TOML path
if config_env() in [:dev, :test] do
  config :grappa, :config_path, System.get_env("GRAPPA_CONFIG") || "grappa.toml"
end
```

- [ ] **Step 12: Write `config/prod.exs`**

```elixir
import Config

config :logger, level: :info

# Runtime values come from runtime.exs.
```

- [ ] **Step 13: Write `test/test_helper.exs`**

```elixir
ExUnit.start(capture_log: true)
# Sandbox setup will be added when Grappa.Repo lands in Task 2:
# Ecto.Adapters.SQL.Sandbox.mode(Grappa.Repo, :manual)
```

- [ ] **Step 14: Verify build**

```bash
mix deps.get
mix compile
mix test    # zero tests, but should pass
```

Expected: clean build, no warnings, zero tests pass.

- [ ] **Step 15: Commit**

```bash
git add mix.exs mix.lock .tool-versions .formatter.exs .credo.exs .gitignore \
        config/ lib/grappa.ex lib/grappa/application.ex test/test_helper.exs
git commit -m "bootstrap: mix project + tooling baseline (Phase 1)"
```

---

## Task 1: TOML config parser

**Files:**
- Create: `lib/grappa/config.ex`
- Create: `test/grappa/config_test.exs`

`Grappa.Config` is the runtime loader for the operator-edited TOML file (network bindings, hardcoded user for Phase 1). It is **distinct** from Mix's `Config` — same name, different namespace.

- [ ] **Step 1: Write the failing test**

Create `test/grappa/config_test.exs`:

```elixir
defmodule Grappa.ConfigTest do
  use ExUnit.Case, async: true

  alias Grappa.Config

  defp write_toml(contents) do
    path = Path.join(System.tmp_dir!(), "grappa-#{System.unique_integer([:positive])}.toml")
    File.write!(path, contents)
    on_exit(fn -> File.rm(path) end)
    path
  end

  test "parses a minimal config with one user and one network" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "azzurra"
      host = "irc.azzurra.chat"
      port = 6697
      tls = true
      nick = "vjt-claude"
      """)

    assert {:ok, %Config{} = cfg} = Config.load(path)
    assert cfg.server.listen == "127.0.0.1:4000"
    assert [user] = cfg.users
    assert user.name == "vjt"
    assert [net] = user.networks
    assert net.id == "azzurra"
    assert net.host == "irc.azzurra.chat"
    assert net.port == 6697
    assert net.tls == true
    assert net.nick == "vjt-claude"
    assert net.sasl_password == nil
    assert net.autojoin == []
  end

  test "rejects a [[users]] entry missing the name field" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      nickname = "wrong-key"
      """)

    assert {:error, msg} = Config.load(path)
    assert msg =~ "name"
  end

  # NOTE: must be a non-empty `[[users]]` block with a wrong key
  # (here `nickname`), NOT an empty `[[users]]`. The TOML parser
  # decodes empty `[[users]]` as `users: []` (zero entries), which
  # never reaches `build_user/1`. Empty-array case is the next test.

  test "rejects an empty users array" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"
      """)

    assert {:error, msg} = Config.load(path)
    assert msg =~ "users"
  end

  test "supports autojoin + sasl_password optional fields" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "azzurra"
      host = "irc.azzurra.chat"
      port = 6697
      tls = true
      nick = "vjt-claude"
      sasl_password = "hunter2"
      autojoin = ["#sniffo", "#it-opers"]
      """)

    assert {:ok, cfg} = Config.load(path)
    [%{networks: [net]}] = cfg.users
    assert net.sasl_password == "hunter2"
    assert net.autojoin == ["#sniffo", "#it-opers"]
  end
end
```

- [ ] **Step 2: Run — verify FAIL**

```bash
mix test test/grappa/config_test.exs
```

Expected: FAIL — `Grappa.Config` does not exist.

- [ ] **Step 3: Implement `lib/grappa/config.ex`**

```elixir
defmodule Grappa.Config do
  @moduledoc """
  Loads and validates the operator-edited TOML config file.

  Phase 1 shape: one server stanza + N users + N networks per user.
  Phase 2 will replace this with dynamic per-user database state.
  """

  defmodule Server do
    @moduledoc false
    @enforce_keys [:listen]
    defstruct [:listen]

    @type t :: %__MODULE__{listen: String.t()}
  end

  defmodule Network do
    @moduledoc false
    @enforce_keys [:id, :host, :port, :tls, :nick]
    defstruct [:id, :host, :port, :tls, :nick, sasl_password: nil, autojoin: []]

    @type t :: %__MODULE__{
            id: String.t(),
            host: String.t(),
            port: 1..65_535,
            tls: boolean(),
            nick: String.t(),
            sasl_password: String.t() | nil,
            autojoin: [String.t()]
          }
  end

  defmodule User do
    @moduledoc false
    @enforce_keys [:name, :networks]
    defstruct [:name, :networks]

    @type t :: %__MODULE__{name: String.t(), networks: [Network.t()]}
  end

  @enforce_keys [:server, :users]
  defstruct [:server, :users]

  @type t :: %__MODULE__{server: Server.t(), users: [User.t()]}

  @doc """
  Loads and validates a TOML config file.

  Returns `{:ok, config}` on success or `{:error, message}` on parse / validation failure.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, String.t()}
  def load(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, parsed} <- Toml.decode(raw),
         {:ok, server} <- build_server(parsed),
         {:ok, users} <- build_users(parsed) do
      {:ok, %__MODULE__{server: server, users: users}}
    else
      # `File.read/1` returns `{:error, posix()}` (an atom), NOT
      # `{:error, %File.Error{}}`. Dialyzer enforces this — confirmed
      # 2026-04-25 (S2). `Toml.decode/1` returns the 2-tuple
      # `{:error, {:invalid_toml, binary}}`, NOT a 3-tuple with line.
      {:error, reason} when is_atom(reason) -> {:error, "cannot read #{path}: #{reason}"}
      {:error, {:invalid_toml, reason}} -> {:error, "invalid toml: #{reason}"}
      {:error, msg} when is_binary(msg) -> {:error, msg}
    end
  end

  defp build_server(%{"server" => %{"listen" => listen}}) when is_binary(listen),
    do: {:ok, %Server{listen: listen}}

  defp build_server(_), do: {:error, "[server] table missing required field: listen"}

  # `[_ | _]` head pattern catches the empty-array case at the head clause
  # — toml decodes empty `[[users]]` as `users: []`, which falls through
  # to `build_users(_)` instead of silently returning {:ok, []}.
  defp build_users(%{"users" => [_ | _] = list}), do: traverse(list, &build_user/1)
  defp build_users(_), do: {:error, "no [[users]] entries found"}

  defp build_user(%{"name" => name} = raw) when is_binary(name) do
    networks_raw = Map.get(raw, "networks", [])

    with {:ok, networks} <- build_networks(networks_raw) do
      {:ok, %User{name: name, networks: networks}}
    end
  end

  defp build_user(_), do: {:error, "[[users]] entry missing required field: name"}

  defp build_networks(list) when is_list(list), do: traverse(list, &build_network/1)

  # Maps `fun` across `list`, collecting successful results.
  # Returns the first `{:error, _}` encountered without visiting the rest.
  # Tail-recursive; replaces an earlier reduce_while + pipe-to-case shape
  # that Credo flagged. See CLAUDE.md "Recursive pattern match over
  # `Enum.reduce_while/3` for collect-or-bail traversal".
  @spec traverse([raw], (raw -> {:ok, item} | {:error, String.t()})) ::
          {:ok, [item]} | {:error, String.t()}
        when raw: term(), item: term()
  defp traverse(list, fun), do: traverse(list, [], fun)

  defp traverse([], acc, _), do: {:ok, Enum.reverse(acc)}

  defp traverse([head | tail], acc, fun) do
    case fun.(head) do
      {:ok, item} -> traverse(tail, [item | acc], fun)
      {:error, _} = err -> err
    end
  end

  defp build_network(%{"id" => id, "host" => host, "port" => port, "tls" => tls, "nick" => nick} = raw)
       when is_binary(id) and is_binary(host) and is_integer(port) and is_boolean(tls) and is_binary(nick) do
    {:ok,
     %Network{
       id: id,
       host: host,
       port: port,
       tls: tls,
       nick: nick,
       sasl_password: Map.get(raw, "sasl_password"),
       autojoin: Map.get(raw, "autojoin", [])
     }}
  end

  defp build_network(raw) do
    missing =
      ~w[id host port tls nick]
      |> Enum.reject(&Map.has_key?(raw, &1))
      |> Enum.join(", ")

    {:error, "[[users.networks]] entry missing required field(s): #{missing}"}
  end
end
```

- [ ] **Step 4: Run — verify PASS**

```bash
mix test test/grappa/config_test.exs
```

Expected: PASS (4 tests).

- [ ] **Step 5: Verify Credo + Dialyzer clean**

```bash
mix credo --strict lib/grappa/config.ex
mix dialyzer
```

Both must pass. If `Specs` rule fires, every public function gets a `@spec`.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/config.ex test/grappa/config_test.exs
git commit -m "config: TOML loader with server + users + networks shape"
```

---

## Task 2: Ecto Repo + sqlite schema + migrations

**Files:**
- Create: `lib/grappa/repo.ex`
- Create: `priv/repo/migrations/20260425000000_init.exs`
- Create: `lib/grappa/scrollback/message.ex` (Ecto schema)
- Create: `test/support/data_case.ex`
- Modify: `lib/grappa/application.ex` (uncomment `Grappa.Repo`)
- Modify: `test/test_helper.exs` (add Sandbox)

- [ ] **Step 1: Write `lib/grappa/repo.ex`**

```elixir
defmodule Grappa.Repo do
  @moduledoc false
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end
```

- [ ] **Step 2: Write the migration**

`priv/repo/migrations/20260425000000_init.exs`:

```elixir
defmodule Grappa.Repo.Migrations.Init do
  use Ecto.Migration

  def change do
    create table(:networks, primary_key: false) do
      add :id, :string, primary_key: true
      add :user_name, :string, null: false
      add :host, :string, null: false
      add :port, :integer, null: false
      add :tls, :boolean, null: false
      add :nick, :string, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create table(:channels, primary_key: false) do
      add :network_id, references(:networks, type: :string), null: false, primary_key: true
      add :name, :string, null: false, primary_key: true
      add :joined_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec)
    end

    # Intentional: no FK from messages.network_id to networks.id.
    # Scrollback is operator-archival — when a network is removed from
    # grappa.toml, its historical messages stay so the operator can
    # re-add the network or audit history. Channels FK on (lifecycle
    # tied to network), messages don't.
    create table(:messages) do
      add :network_id, :string, null: false
      add :channel, :string, null: false
      add :server_time, :integer, null: false   # epoch milliseconds
      # `kind` enforcement lives at the schema layer via Ecto.Enum.
      # SQLite doesn't support ALTER TABLE ADD CONSTRAINT, and Ecto's
      # migration DSL doesn't expose inline column CHECK clauses for
      # the SQLite adapter, so a DB-level guard would need raw
      # `execute/1` — which trades reversibility + readability for a
      # backstop against a code path (raw SQL INSERT) that CLAUDE.md
      # already forbids.
      add :kind, :string, null: false
      add :sender, :string, null: false
      add :body, :text, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create index(:messages, [:network_id, :channel, :server_time])
  end
end
```

- [ ] **Step 3: Write `lib/grappa/scrollback/message.ex`**

```elixir
defmodule Grappa.Scrollback.Message do
  @moduledoc """
  One row of IRC scrollback.

  `kind` is stored as a closed-set atom via `Ecto.Enum` — never an
  untyped string. See CLAUDE.md "Atoms or `@type t :: literal | literal`
  — never untyped strings for closed sets."
  """
  use Ecto.Schema
  import Ecto.Changeset

  @kinds [:privmsg, :notice, :action]

  @type kind :: :privmsg | :notice | :action

  @type t :: %__MODULE__{
          id: integer() | nil,
          network_id: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t(),
          inserted_at: DateTime.t() | nil
        }

  schema "messages" do
    field :network_id, :string
    field :channel, :string
    field :server_time, :integer
    field :kind, Ecto.Enum, values: @kinds
    field :sender, :string
    field :body, :string

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc """
  Builds an insert changeset. All fields required; `:kind` validated
  against the `Ecto.Enum` value set at cast time.
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(message, attrs) do
    message
    |> cast(attrs, [:network_id, :channel, :server_time, :kind, :sender, :body])
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender, :body])
  end
end
```

- [ ] **Step 4: Write `test/support/data_case.ex`**

```elixir
defmodule Grappa.DataCase do
  @moduledoc false
  use ExUnit.CaseTemplate

  using do
    quote do
      alias Grappa.Repo
      import Ecto
      import Ecto.Changeset
      import Ecto.Query
      import Grappa.DataCase
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
```

- [ ] **Step 5: Update `test/test_helper.exs`**

```elixir
ExUnit.start(capture_log: true)
Ecto.Adapters.SQL.Sandbox.mode(Grappa.Repo, :manual)
```

- [ ] **Step 6: Uncomment Repo in `lib/grappa/application.ex`**

```elixir
children = [
  Grappa.Repo,
  {Phoenix.PubSub, name: Grappa.PubSub},
  ...
]
```

- [ ] **Step 7: Verify Repo + migrations**

```bash
mix ecto.create
mix ecto.migrate
mix test    # still no scrollback tests yet, but Repo must boot
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/grappa/repo.ex priv/repo/migrations/ lib/grappa/scrollback/ \
        test/support/data_case.ex test/test_helper.exs lib/grappa/application.ex
git commit -m "db: Ecto Repo + sqlite migration for networks/channels/messages"
```

---

## Task 3: Scrollback context (insert + paginated fetch)

**Files:**
- Create: `lib/grappa/scrollback.ex`
- Create: `test/grappa/scrollback_test.exs`

`Grappa.Scrollback` is the context boundary. Public API: `insert/1`, `fetch/4`. Internals (`Grappa.Scrollback.Message`) stay encapsulated. Boundary library will enforce this in Task 10.

- [ ] **Step 1: Write the failing test**

```elixir
defmodule Grappa.ScrollbackTest do
  use Grappa.DataCase, async: true

  alias Grappa.Scrollback
  alias Grappa.Scrollback.Message

  defp sample(i) do
    %{
      network_id: "azzurra",
      channel: "#sniffo",
      server_time: i,
      kind: "privmsg",
      sender: "vjt",
      body: "msg #{i}"
    }
  end

  test "inserts and fetches the latest page in descending server_time order" do
    for i <- 0..4 do
      assert {:ok, %Message{}} = Scrollback.insert(sample(i))
    end

    page = Scrollback.fetch("azzurra", "#sniffo", nil, 3)
    assert length(page) == 3
    assert Enum.at(page, 0).body == "msg 4"
    assert Enum.at(page, 2).body == "msg 2"
  end

  test "paginates by `before` cursor" do
    for i <- 0..4, do: {:ok, _} = Scrollback.insert(sample(i))

    [first, _] = Scrollback.fetch("azzurra", "#sniffo", nil, 2)
    cursor = Enum.at(Scrollback.fetch("azzurra", "#sniffo", nil, 2), -1).server_time
    second_page = Scrollback.fetch("azzurra", "#sniffo", cursor, 2)
    assert length(second_page) == 2
    assert Enum.at(second_page, 0).body == "msg 2"
    assert Enum.at(second_page, 1).body == "msg 1"
    assert first.body == "msg 4"
  end

  test "isolates by channel" do
    {:ok, _} = Scrollback.insert(%{sample(0) | channel: "#a"})
    {:ok, _} = Scrollback.insert(%{sample(1) | channel: "#b"})

    page = Scrollback.fetch("azzurra", "#a", nil, 10)
    assert length(page) == 1
    assert hd(page).channel == "#a"
  end

  test "rejects invalid kind" do
    assert {:error, changeset} = Scrollback.insert(%{sample(0) | kind: "bogus"})
    assert "is invalid" in errors_on(changeset).kind
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
```

- [ ] **Step 2: Run — FAIL**

```bash
mix test test/grappa/scrollback_test.exs
```

- [ ] **Step 3: Implement `lib/grappa/scrollback.ex`**

```elixir
defmodule Grappa.Scrollback do
  @moduledoc """
  Bouncer-owned scrollback persistence.

  Schema is designed so a future `CHATHISTORY` listener facade is a mechanical
  query translation, not a redesign:
  - monotonic `id` for stable ordering inside a single `server_time`,
  - `server_time` indexed by (network_id, channel) for paginated lookup.
  """

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  @max_limit 500

  @doc """
  Inserts a new message row.

  Returns `{:ok, message}` or `{:error, changeset}`.
  """
  @spec insert(map()) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs) do
    %Message{}
    |> Message.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Fetches up to `limit` messages from `(network_id, channel)`,
  ordered by `server_time` DESC. If `before` is non-nil, only returns
  rows with `server_time < before`.
  """
  @spec fetch(String.t(), String.t(), integer() | nil, pos_integer()) :: [Message.t()]
  def fetch(network_id, channel, before, limit) do
    limit = min(max(limit, 1), @max_limit)

    query =
      from m in Message,
        where: m.network_id == ^network_id and m.channel == ^channel,
        order_by: [desc: m.server_time, desc: m.id],
        limit: ^limit

    query =
      if is_integer(before) do
        from m in query, where: m.server_time < ^before
      else
        query
      end

    Repo.all(query)
  end
end
```

- [ ] **Step 4: Run — PASS**

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/scrollback.ex test/grappa/scrollback_test.exs
git commit -m "scrollback: insert + paginated fetch by (network_id, channel, server_time)"
```

---

## Task 4: Phoenix Endpoint + /healthz

**Files:**
- Create: `lib/grappa_web.ex`
- Create: `lib/grappa_web/endpoint.ex`
- Create: `lib/grappa_web/router.ex`
- Create: `lib/grappa_web/controllers/error_json.ex`
- Create: `lib/grappa_web/controllers/fallback_controller.ex`
- Create: `test/support/conn_case.ex`
- Modify: `lib/grappa/application.ex` (uncomment `GrappaWeb.Endpoint`)

- [ ] **Step 1: Write the failing smoke test**

`test/grappa_web/healthz_test.exs`:

```elixir
defmodule GrappaWeb.HealthzTest do
  use GrappaWeb.ConnCase, async: true

  test "GET /healthz returns 200 ok", %{conn: conn} do
    conn = get(conn, "/healthz")
    assert response(conn, 200) == "ok"
  end
end
```

- [ ] **Step 2: Write `lib/grappa_web.ex`**

```elixir
defmodule GrappaWeb do
  @moduledoc false

  def controller do
    quote do
      use Phoenix.Controller, formats: [:json]
      import Plug.Conn
      action_fallback GrappaWeb.FallbackController
    end
  end

  def router do
    quote do
      use Phoenix.Router, helpers: false
      import Plug.Conn
      import Phoenix.Controller
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
```

- [ ] **Step 3: Write `lib/grappa_web/endpoint.ex`**

```elixir
defmodule GrappaWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :grappa

  @session_options [
    store: :cookie,
    key: "_grappa_key",
    signing_salt: "rotate-me",
    same_site: "Lax"
  ]

  socket "/socket", GrappaWeb.UserSocket,
    websocket: true,
    longpoll: false

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug GrappaWeb.Router
end
```

- [ ] **Step 4: Write `lib/grappa_web/router.ex`**

```elixir
defmodule GrappaWeb.Router do
  use GrappaWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", GrappaWeb do
    pipe_through []
    get "/healthz", HealthController, :show
  end

  scope "/", GrappaWeb do
    pipe_through :api
    # Routes added in Task 5+
  end
end
```

And `lib/grappa_web/controllers/health_controller.ex`:

```elixir
defmodule GrappaWeb.HealthController do
  use GrappaWeb, :controller

  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _params), do: text(conn, "ok")
end
```

- [ ] **Step 5: Write `lib/grappa_web/controllers/error_json.ex` and `fallback_controller.ex`**

```elixir
defmodule GrappaWeb.ErrorJSON do
  @moduledoc false
  def render(template, _assigns), do: %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
end

defmodule GrappaWeb.FallbackController do
  @moduledoc false
  use GrappaWeb, :controller

  def call(conn, {:error, :not_found}) do
    conn |> put_status(:not_found) |> json(%{error: "not found"})
  end

  def call(conn, {:error, %Ecto.Changeset{} = changeset}) do
    conn |> put_status(:unprocessable_entity) |> json(%{errors: traverse(changeset)})
  end

  defp traverse(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {k, v}, acc -> String.replace(acc, "%{#{k}}", to_string(v)) end)
    end)
  end
end
```

- [ ] **Step 6: Write `test/support/conn_case.ex`**

```elixir
defmodule GrappaWeb.ConnCase do
  use ExUnit.CaseTemplate

  using do
    quote do
      use GrappaWeb, :verified_routes_off
      import Plug.Conn
      import Phoenix.ConnTest
      import GrappaWeb.ConnCase

      alias GrappaWeb.Router.Helpers, as: Routes
      @endpoint GrappaWeb.Endpoint
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    {:ok, conn: Phoenix.ConnTest.build_conn()}
  end
end
```

(`:verified_routes_off` is a hack — Phoenix 1.8 default is verified routes; for Phase 1 the simpler conn-test path is fine. If this trips, replace with `use Phoenix.VerifiedRoutes, endpoint: GrappaWeb.Endpoint, router: GrappaWeb.Router`.)

- [ ] **Step 7: Uncomment Endpoint in application.ex**

```elixir
children = [
  Grappa.Repo,
  {Phoenix.PubSub, name: Grappa.PubSub},
  {Registry, ...},
  {DynamicSupervisor, ...},
  GrappaWeb.Endpoint
]
```

- [ ] **Step 8: Run — PASS**

```bash
mix test test/grappa_web/healthz_test.exs
```

- [ ] **Step 9: Manual smoke**

```bash
iex -S mix
# In iex:
:inets.start()
{:ok, {{_, 200, _}, _, body}} = :httpc.request(:get, {~c'http://localhost:4000/healthz', []}, [], [])
IO.inspect(body)  # 'ok'
```

Or via curl: `curl http://localhost:4000/healthz` → `ok`.

- [ ] **Step 10: Commit**

```bash
git add lib/grappa_web.ex lib/grappa_web/ test/support/conn_case.ex \
        test/grappa_web/healthz_test.exs lib/grappa/application.ex
git commit -m "web: Phoenix Endpoint + Router + /healthz"
```

---

## Task 5: GET /networks/:net/channels/:chan/messages

**Files:**
- Create: `lib/grappa_web/controllers/messages_controller.ex`
- Create: `lib/grappa_web/controllers/messages_json.ex`
- Modify: `lib/grappa_web/router.ex`
- Create: `test/grappa_web/controllers/messages_controller_test.exs`

- [ ] **Step 1: Write the failing tests**

```elixir
defmodule GrappaWeb.MessagesControllerTest do
  use GrappaWeb.ConnCase, async: true

  alias Grappa.Scrollback

  defp seed do
    for i <- 0..4 do
      {:ok, _} =
        Scrollback.insert(%{
          network_id: "azzurra",
          channel: "#sniffo",
          server_time: i,
          kind: "privmsg",
          sender: "vjt",
          body: "m#{i}"
        })
    end
  end

  test "GET ?limit=3 returns latest page descending", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=3")
    body = json_response(conn, 200)
    assert length(body) == 3
    assert Enum.at(body, 0)["body"] == "m4"
    assert Enum.at(body, 2)["body"] == "m2"
  end

  test "GET ?before=3&limit=2 paginates correctly", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=3&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    assert Enum.at(body, 0)["body"] == "m2"
    assert Enum.at(body, 1)["body"] == "m1"
  end

  test "limit defaults to 50 when omitted", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 5
  end
end
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement controller + view**

`lib/grappa_web/controllers/messages_controller.ex`:

```elixir
defmodule GrappaWeb.MessagesController do
  use GrappaWeb, :controller

  alias Grappa.Scrollback

  @default_limit 50

  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, %{"network_id" => network, "channel_id" => channel} = params) do
    before = parse_int(params["before"])
    limit = parse_int(params["limit"]) || @default_limit
    rows = Scrollback.fetch(network, channel, before, limit)
    json(conn, Enum.map(rows, &serialize/1))
  end

  defp parse_int(nil), do: nil
  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> n
      _ -> nil
    end
  end

  defp serialize(%Grappa.Scrollback.Message{} = m) do
    %{
      id: m.id,
      network_id: m.network_id,
      channel: m.channel,
      server_time: m.server_time,
      kind: m.kind,
      sender: m.sender,
      body: m.body
    }
  end
end
```

- [ ] **Step 4: Wire route in router**

```elixir
scope "/", GrappaWeb do
  pipe_through :api
  get "/networks/:network_id/channels/:channel_id/messages", MessagesController, :index
end
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add lib/grappa_web/controllers/messages_controller.ex lib/grappa_web/router.ex \
        test/grappa_web/controllers/messages_controller_test.exs
git commit -m "web: GET /networks/:net/channels/:chan/messages (paginated)"
```

---

## Task 6: POST /networks/:net/channels/:chan/messages

**Files:**
- Modify: `lib/grappa_web/controllers/messages_controller.ex`
- Modify: `lib/grappa_web/router.ex`
- Modify: `test/grappa_web/controllers/messages_controller_test.exs`

This task wires inbound writes to scrollback and broadcasts the new event over `Phoenix.PubSub`. It does **not** yet route to the upstream IRC session — Task 9 adds that. For now, `sender = "<local>"`.

- [ ] **Step 1: Append failing test**

```elixir
test "POST stores message, returns 201, broadcasts via PubSub", %{conn: conn} do
  topic = "grappa:network:azzurra/channel:#sniffo"
  Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

  conn =
    conn
    |> put_req_header("content-type", "application/json")
    |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "ciao raga"})

  body = json_response(conn, 201)
  assert body["body"] == "ciao raga"
  assert body["channel"] == "#sniffo"
  assert body["kind"] == "privmsg"

  assert_receive {:event, %{kind: :message, body: "ciao raga"}}, 200
end
```

- [ ] **Step 2: Run — FAIL** (405 / 404).

- [ ] **Step 3: Implement `create/2`**

Add to `MessagesController`:

```elixir
@spec create(Plug.Conn.t(), map()) :: Plug.Conn.t()
def create(conn, %{"network_id" => network, "channel_id" => channel, "body" => body})
    when is_binary(body) and body != "" do
  attrs = %{
    network_id: network,
    channel: channel,
    server_time: System.system_time(:millisecond),
    kind: "privmsg",
    sender: "<local>",
    body: body
  }

  case Scrollback.insert(attrs) do
    {:ok, msg} ->
      broadcast(network, channel, msg)
      conn |> put_status(:created) |> json(serialize(msg))

    {:error, changeset} ->
      {:error, changeset}
  end
end

def create(_conn, _params), do: {:error, :bad_request}

defp broadcast(network, channel, msg) do
  topic = "grappa:network:#{network}/channel:#{channel}"
  event = %{kind: :message, message: serialize(msg), body: msg.body}
  Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, event})
end
```

And FallbackController:

```elixir
def call(conn, {:error, :bad_request}), do: conn |> put_status(:bad_request) |> json(%{error: "bad request"})
```

- [ ] **Step 4: Add route**

```elixir
post "/networks/:network_id/channels/:channel_id/messages", MessagesController, :create
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add lib/grappa_web/controllers/ lib/grappa_web/router.ex \
        test/grappa_web/controllers/messages_controller_test.exs
git commit -m "web: POST /networks/:net/channels/:chan/messages (local echo + PubSub)"
```

---

## Task 7: Phoenix Channel for `/socket/websocket`

**Files:**
- Create: `lib/grappa_web/channels/user_socket.ex`
- Create: `lib/grappa_web/channels/grappa_channel.ex`
- Create: `test/support/channel_case.ex`
- Create: `test/grappa_web/channels/grappa_channel_test.exs`

- [ ] **Step 1: Write `test/support/channel_case.ex`**

```elixir
defmodule GrappaWeb.ChannelCase do
  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import GrappaWeb.ChannelCase
      @endpoint GrappaWeb.Endpoint
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
```

- [ ] **Step 2: Write the failing test**

```elixir
defmodule GrappaWeb.GrappaChannelTest do
  use GrappaWeb.ChannelCase, async: true

  alias GrappaWeb.UserSocket

  test "joining a network/channel topic delivers PubSub-broadcast events" do
    {:ok, _, socket} =
      UserSocket
      |> socket("user_socket:vjt", %{user_name: "vjt"})
      |> subscribe_and_join("grappa:network:azzurra/channel:#sniffo", %{})

    assert socket

    Phoenix.PubSub.broadcast(
      Grappa.PubSub,
      "grappa:network:azzurra/channel:#sniffo",
      {:event, %{kind: :message, body: "hello"}}
    )

    assert_push "event", %{kind: :message, body: "hello"}
  end

  test "rejects join on unsupported topic shape" do
    assert {:error, %{reason: "unknown topic"}} =
             UserSocket
             |> socket("user_socket:vjt", %{user_name: "vjt"})
             |> subscribe_and_join("grappa:bogus:lol", %{})
  end
end
```

- [ ] **Step 3: Run — FAIL**

- [ ] **Step 4: Implement `lib/grappa_web/channels/user_socket.ex`**

```elixir
defmodule GrappaWeb.UserSocket do
  use Phoenix.Socket

  channel "grappa:user:*", GrappaWeb.GrappaChannel
  channel "grappa:network:*", GrappaWeb.GrappaChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    # Phase 2 will validate token here. Phase 1 hardcodes vjt.
    {:ok, assign(socket, :user_name, "vjt")}
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_name}"
end
```

- [ ] **Step 5: Implement `lib/grappa_web/channels/grappa_channel.ex`**

```elixir
defmodule GrappaWeb.GrappaChannel do
  use GrappaWeb, :channel

  @impl true
  def join("grappa:user:" <> _user, _params, socket) do
    Phoenix.PubSub.subscribe(Grappa.PubSub, socket.topic)
    {:ok, socket}
  end

  def join("grappa:network:" <> _rest = topic, _params, socket) do
    if valid_network_topic?(topic) do
      Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
      {:ok, socket}
    else
      {:error, %{reason: "unknown topic"}}
    end
  end

  def join(_topic, _params, _socket), do: {:error, %{reason: "unknown topic"}}

  @impl true
  def handle_info({:event, payload}, socket) do
    push(socket, "event", payload)
    {:noreply, socket}
  end

  defp valid_network_topic?("grappa:network:" <> rest) do
    case String.split(rest, "/", parts: 2) do
      [_net] -> true
      [_net, "channel:" <> _chan] -> true
      _ -> false
    end
  end
end
```

- [ ] **Step 6: Run — PASS**

- [ ] **Step 7: Commit**

```bash
git add lib/grappa_web/channels/ test/support/channel_case.ex test/grappa_web/channels/
git commit -m "web: Phoenix Channels for grappa:user/* and grappa:network/* topics"
```

---

## Task 8: Grappa.IRC.Client + Grappa.Session GenServer

**Files:**
- Create: `lib/grappa/irc/message.ex`
- Create: `lib/grappa/irc/parser.ex`
- Create: `lib/grappa/irc/client.ex`
- Create: `lib/grappa/session/server.ex`
- Create: `lib/grappa/session/supervisor.ex`
- Create: `lib/grappa/bootstrap.ex`
- Create: `test/grappa/irc/parser_test.exs`
- Create: `test/grappa/session/server_test.exs`
- Create: `test/support/irc_server.ex`
- Modify: `lib/grappa/application.ex`

This task is the largest and the most domain-specific. We write our own minimal IRC client because `exirc` is stale, and binary pattern matching makes it ergonomic.

### Sub-task 8a: IRC parser

- [ ] **Step 1: Define `lib/grappa/irc/message.ex`**

```elixir
defmodule Grappa.IRC.Message do
  @moduledoc false

  @type prefix :: {:nick, String.t(), String.t() | nil, String.t() | nil} | {:server, String.t()} | nil
  @type t :: %__MODULE__{
          tags: %{optional(String.t()) => String.t() | true},
          prefix: prefix(),
          command: String.t(),
          params: [String.t()]
        }

  defstruct tags: %{}, prefix: nil, command: "", params: []
end
```

- [ ] **Step 2: Failing parser tests**

```elixir
defmodule Grappa.IRC.ParserTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.Message
  alias Grappa.IRC.Parser

  test "parses a basic PRIVMSG" do
    line = ":vjt!~vjt@host PRIVMSG #sniffo :ciao raga"
    assert {:ok, %Message{prefix: {:nick, "vjt", "~vjt", "host"}, command: "PRIVMSG", params: ["#sniffo", "ciao raga"], tags: tags}} = Parser.parse(line)
    assert tags == %{}
  end

  test "parses a server-prefixed numeric reply" do
    line = ":irc.azzurra.chat 376 vjt :End of MOTD"
    assert {:ok, %Message{prefix: {:server, "irc.azzurra.chat"}, command: "376", params: ["vjt", "End of MOTD"]}} = Parser.parse(line)
  end

  test "parses a tagged message (IRCv3 message-tags)" do
    line = "@time=2026-04-25T12:00:00.000Z;account=vjt :vjt!~vjt@host PRIVMSG #sniffo :hi"
    assert {:ok, %Message{tags: tags, command: "PRIVMSG"}} = Parser.parse(line)
    assert tags["time"] == "2026-04-25T12:00:00.000Z"
    assert tags["account"] == "vjt"
  end

  test "parses a no-prefix command (PING)" do
    line = "PING :foo.bar"
    assert {:ok, %Message{prefix: nil, command: "PING", params: ["foo.bar"]}} = Parser.parse(line)
  end

  test "parses CAP LS reply" do
    line = ":irc.azzurra.chat CAP * LS :sasl multi-prefix"
    assert {:ok, %Message{command: "CAP", params: ["*", "LS", "sasl multi-prefix"]}} = Parser.parse(line)
  end

  test "rejects empty input" do
    assert {:error, :empty} = Parser.parse("")
  end
end
```

- [ ] **Step 3: Implement `lib/grappa/irc/parser.ex`**

```elixir
defmodule Grappa.IRC.Parser do
  @moduledoc """
  Minimal RFC 2812 + IRCv3.1 message-tags parser.

  Returns `{:ok, %Grappa.IRC.Message{}}` or `{:error, reason}`.
  """

  alias Grappa.IRC.Message

  @spec parse(binary()) :: {:ok, Message.t()} | {:error, atom()}
  def parse(""), do: {:error, :empty}
  def parse(line) when is_binary(line) do
    line
    |> String.trim_trailing("\r")
    |> do_parse()
  end

  defp do_parse(""), do: {:error, :empty}

  defp do_parse("@" <> rest) do
    case String.split(rest, " ", parts: 2) do
      [tags_raw, after_tags] -> after_prefix_or_command(after_tags, parse_tags(tags_raw))
      _ -> {:error, :malformed_tags}
    end
  end

  defp do_parse(line), do: after_prefix_or_command(line, %{})

  defp after_prefix_or_command(":" <> rest, tags) do
    case String.split(rest, " ", parts: 2) do
      [prefix_raw, after_prefix] ->
        prefix = parse_prefix(prefix_raw)
        finish(after_prefix, tags, prefix)

      _ -> {:error, :malformed_prefix}
    end
  end

  defp after_prefix_or_command(line, tags), do: finish(line, tags, nil)

  defp finish(line, tags, prefix) do
    {command, params_raw} = take_command(line)

    case command do
      "" -> {:error, :missing_command}
      _ -> {:ok, %Message{tags: tags, prefix: prefix, command: command, params: parse_params(params_raw)}}
    end
  end

  defp take_command(line) do
    case String.split(line, " ", parts: 2) do
      [cmd] -> {cmd, ""}
      [cmd, rest] -> {cmd, rest}
    end
  end

  defp parse_params(""), do: []
  defp parse_params(":" <> trailing), do: [trailing]

  defp parse_params(rest) do
    case String.split(rest, " ", parts: 2) do
      [single] -> [single]
      [first, ":" <> trailing] -> [first, trailing]
      [first, more] -> [first | parse_params(more)]
    end
  end

  defp parse_prefix(raw) do
    case String.split(raw, ["!", "@"], parts: 3) do
      [nick, user, host] -> {:nick, nick, user, host}
      [nick, host] -> {:nick, nick, nil, host}
      [single] ->
        if String.contains?(single, "."), do: {:server, single}, else: {:nick, single, nil, nil}
    end
  end

  defp parse_tags(raw) do
    raw
    |> String.split(";")
    |> Enum.into(%{}, fn tag ->
      case String.split(tag, "=", parts: 2) do
        [k, v] -> {k, v}
        [k] -> {k, true}
      end
    end)
  end
end
```

- [ ] **Step 4: Run parser tests — PASS**

### Sub-task 8b: IRC client GenServer

The `Grappa.IRC.Client` is a GenServer that owns a TCP socket (or TLS via `:ssl`), reads bytes, splits on `\r\n`, parses each line via `Grappa.IRC.Parser`, and forwards parsed messages to a designated `:dispatch_to` pid via `send/2`.

- [ ] **Step 5: Implement `lib/grappa/irc/client.ex`**

```elixir
defmodule Grappa.IRC.Client do
  @moduledoc """
  Minimal IRC client GenServer.

  Owns a TCP/TLS socket, parses incoming lines via `Grappa.IRC.Parser`,
  forwards parsed `%Grappa.IRC.Message{}` structs to `:dispatch_to` (a pid).

  Outbound API: `send_line/2`, `send_privmsg/3`, `send_join/2`, `send_part/2`.

  Phase 1: no reconnect logic — supervisor restarts the whole session
  GenServer (which spawns a fresh Client) on disconnect.
  """

  use GenServer
  require Logger

  alias Grappa.IRC.Parser

  @type connect_opts :: %{
          host: String.t(),
          port: 1..65_535,
          tls: boolean(),
          dispatch_to: pid()
        }

  @spec start_link(connect_opts()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @spec send_line(pid(), iodata()) :: :ok
  def send_line(client, line), do: GenServer.cast(client, {:send, line})

  @spec send_privmsg(pid(), String.t(), String.t()) :: :ok
  def send_privmsg(client, target, body), do: send_line(client, "PRIVMSG #{target} :#{body}\r\n")

  @spec send_join(pid(), String.t()) :: :ok
  def send_join(client, channel), do: send_line(client, "JOIN #{channel}\r\n")

  @spec send_part(pid(), String.t()) :: :ok
  def send_part(client, channel), do: send_line(client, "PART #{channel}\r\n")

  # ── GenServer

  @impl true
  def init(%{host: host, port: port, tls: tls, dispatch_to: dispatch_to} = opts) do
    Logger.metadata(network: opts[:network_id], host: host, port: port)

    case connect(host, port, tls) do
      {:ok, socket, mod} ->
        {:ok, %{socket: socket, mod: mod, buffer: "", dispatch_to: dispatch_to, opts: opts}}

      {:error, reason} ->
        {:stop, {:connect_failed, reason}}
    end
  end

  @impl true
  def handle_cast({:send, line}, state) do
    :ok = state.mod.send(state.socket, line)
    {:noreply, state}
  end

  @impl true
  def handle_info({:tcp, _socket, data}, state), do: handle_data(data, state)
  def handle_info({:ssl, _socket, data}, state), do: handle_data(data, state)
  def handle_info({:tcp_closed, _}, state), do: {:stop, :tcp_closed, state}
  def handle_info({:ssl_closed, _}, state), do: {:stop, :ssl_closed, state}
  def handle_info({:tcp_error, _, reason}, state), do: {:stop, {:tcp_error, reason}, state}
  def handle_info({:ssl_error, _, reason}, state), do: {:stop, {:ssl_error, reason}, state}

  defp handle_data(data, state) do
    {lines, rest} = split_lines(state.buffer <> data)

    Enum.each(lines, fn raw ->
      case Parser.parse(raw) do
        {:ok, msg} -> send(state.dispatch_to, {:irc, msg})
        {:error, reason} -> Logger.warning("irc parse failed", reason: reason, raw: inspect(raw))
      end
    end)

    {:noreply, %{state | buffer: rest}}
  end

  defp split_lines(buf) do
    case String.split(buf, "\r\n") do
      [partial] -> {[], partial}
      parts -> {Enum.drop(parts, -1), List.last(parts)}
    end
  end

  defp connect(host, port, false) do
    case :gen_tcp.connect(String.to_charlist(host), port, [:binary, active: true, packet: :line]) do
      {:ok, sock} -> {:ok, sock, :gen_tcp}
      err -> err
    end
  end

  defp connect(host, port, true) do
    case :ssl.connect(String.to_charlist(host), port, [:binary, active: true, packet: :line, verify: :verify_none]) do
      {:ok, sock} -> {:ok, sock, :ssl}
      err -> err
    end
  end
end
```

(`packet: :line` lets `:gen_tcp`/`:ssl` deliver line-buffered data, simplifying our buffer logic. `verify: :verify_none` is a Phase 1 expedient — Phase 5 hardening adds proper CA verification.)

### Sub-task 8c: Grappa.Session.Server

- [ ] **Step 6: Define the in-process fake IRC server in `test/support/irc_server.ex`**

```elixir
defmodule Grappa.IRCServer do
  @moduledoc """
  Tiny in-process IRC server for tests. Accepts one connection on an
  ephemeral port, replies to client lines via a configurable handler.
  """

  use GenServer

  def start_link(handler) when is_function(handler, 2) do
    GenServer.start_link(__MODULE__, handler)
  end

  def port(pid), do: GenServer.call(pid, :port)
  def feed(pid, line), do: GenServer.cast(pid, {:feed, line})

  @impl true
  def init(handler) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, packet: :line, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    me = self()
    spawn_link(fn -> accept_loop(listen, handler, me) end)
    {:ok, %{port: port, listen: listen, sock: nil}}
  end

  @impl true
  def handle_call(:port, _from, state), do: {:reply, state.port, state}

  @impl true
  def handle_cast({:feed, line}, state) do
    if state.sock, do: :gen_tcp.send(state.sock, line)
    {:noreply, state}
  end

  @impl true
  def handle_info({:client, sock}, state) do
    {:noreply, %{state | sock: sock}}
  end

  defp accept_loop(listen, handler, parent) do
    {:ok, sock} = :gen_tcp.accept(listen)
    send(parent, {:client, sock})
    loop(sock, handler)
  end

  defp loop(sock, handler) do
    case :gen_tcp.recv(sock, 0, :infinity) do
      {:ok, line} ->
        handler.(sock, line)
        loop(sock, handler)

      {:error, _} -> :ok
    end
  end
end
```

- [ ] **Step 7: Failing session test**

```elixir
defmodule Grappa.Session.ServerTest do
  use Grappa.DataCase, async: false

  alias Grappa.Scrollback

  test "session connects, registers, joins, receives PRIVMSG, persists + broadcasts" do
    handler = fn sock, line ->
      cond do
        String.starts_with?(line, "CAP LS") -> :gen_tcp.send(sock, ":server CAP * LS :\r\n")
        String.starts_with?(line, "CAP END") -> :gen_tcp.send(sock, ":server 001 vjt :Welcome\r\n")
        String.starts_with?(line, "NICK") -> :ok
        String.starts_with?(line, "USER") -> :ok
        String.starts_with?(line, "JOIN") -> :gen_tcp.send(sock, ":vjt!~vjt@h JOIN #sniffo\r\n")
        true -> :ok
      end
    end

    {:ok, server} = Grappa.IRCServer.start_link(handler)
    port = Grappa.IRCServer.port(server)

    Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:test/channel:#sniffo")

    {:ok, _pid} =
      Grappa.Session.Supervisor.start_session(%{
        user_name: "vjt",
        network: %Grappa.Config.Network{
          id: "test",
          host: "127.0.0.1",
          port: port,
          tls: false,
          nick: "vjt",
          autojoin: ["#sniffo"]
        }
      })

    # Server pushes a PRIVMSG; session must persist + broadcast
    Grappa.IRCServer.feed(server, ":alice!~a@h PRIVMSG #sniffo :hello\r\n")
    assert_receive {:event, %{kind: :message, body: "hello"}}, 1_000

    [row] = Scrollback.fetch("test", "#sniffo", nil, 10)
    assert row.body == "hello"
    assert row.sender == "alice"
  end
end
```

- [ ] **Step 8: Implement `lib/grappa/session/supervisor.ex`**

```elixir
defmodule Grappa.Session.Supervisor do
  @moduledoc false

  alias Grappa.Session

  @type start_opts :: %{user_name: String.t(), network: Grappa.Config.Network.t()}

  @spec start_session(start_opts()) :: DynamicSupervisor.on_start_child()
  def start_session(%{user_name: user, network: net} = opts) do
    spec = {Session.Server, opts}
    DynamicSupervisor.start_child(Grappa.SessionSupervisor, spec)
  end
end
```

- [ ] **Step 9: Implement `lib/grappa/session/server.ex`**

```elixir
defmodule Grappa.Session.Server do
  @moduledoc """
  One supervised GenServer per (user, network).

  Owns:
    - the upstream IRC client (`Grappa.IRC.Client`)
    - per-channel autojoin state
    - dispatch from incoming IRC frames to scrollback + PubSub
  """

  use GenServer
  require Logger

  alias Grappa.{IRC, Scrollback}
  alias Grappa.IRC.Message

  defstruct [:user_name, :network, :client_pid]

  @type state :: %__MODULE__{
          user_name: String.t(),
          network: Grappa.Config.Network.t(),
          client_pid: pid() | nil
        }

  def start_link(%{user_name: user, network: net} = opts) do
    GenServer.start_link(__MODULE__, opts, name: via(user, net.id))
  end

  defp via(user, net_id), do: {:via, Registry, {Grappa.SessionRegistry, {user, net_id}}}

  @doc "Sends a PRIVMSG to the given channel via this session's upstream connection."
  @spec send_privmsg(pid() | {:via, _, _}, String.t(), String.t()) :: :ok
  def send_privmsg(session, channel, body), do: GenServer.cast(session, {:privmsg, channel, body})

  @spec send_join(pid() | {:via, _, _}, String.t()) :: :ok
  def send_join(session, channel), do: GenServer.cast(session, {:join, channel})

  @spec send_part(pid() | {:via, _, _}, String.t()) :: :ok
  def send_part(session, channel), do: GenServer.cast(session, {:part, channel})

  # ── GenServer

  @impl true
  def init(%{user_name: user, network: net}) do
    Logger.metadata(user: user, network: net.id)

    {:ok, client} =
      IRC.Client.start_link(%{
        host: net.host,
        port: net.port,
        tls: net.tls,
        dispatch_to: self(),
        network_id: net.id
      })

    Process.link(client)

    # Phase 1: no SASL — emit NICK/USER, then JOIN autojoin on welcome
    IRC.Client.send_line(client, "CAP LS 302\r\n")
    IRC.Client.send_line(client, "CAP END\r\n")
    IRC.Client.send_line(client, "NICK #{net.nick}\r\n")
    IRC.Client.send_line(client, "USER #{net.nick} 0 * :grappa\r\n")

    {:ok, %__MODULE__{user_name: user, network: net, client_pid: client}}
  end

  @impl true
  def handle_cast({:privmsg, chan, body}, state) do
    IRC.Client.send_privmsg(state.client_pid, chan, body)
    {:noreply, state}
  end

  def handle_cast({:join, chan}, state) do
    IRC.Client.send_join(state.client_pid, chan)
    {:noreply, state}
  end

  def handle_cast({:part, chan}, state) do
    IRC.Client.send_part(state.client_pid, chan)
    {:noreply, state}
  end

  @impl true
  def handle_info({:irc, %Message{command: "001"}}, state) do
    Enum.each(state.network.autojoin, fn chan ->
      IRC.Client.send_join(state.client_pid, chan)
    end)

    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: "PING", params: [token]}}, state) do
    IRC.Client.send_line(state.client_pid, "PONG :#{token}\r\n")
    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: "PRIVMSG", params: [target, body], prefix: prefix}}, state) do
    sender = nick_of(prefix)
    server_time = System.system_time(:millisecond)

    {:ok, msg} =
      Scrollback.insert(%{
        network_id: state.network.id,
        channel: target,
        server_time: server_time,
        kind: "privmsg",
        sender: sender,
        body: body
      })

    broadcast(state, target, %{kind: :message, message: msg, body: body, sender: sender})
    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: "JOIN", params: [chan], prefix: prefix}}, state) do
    broadcast(state, chan, %{kind: :join, nick: nick_of(prefix), channel: chan})
    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: "PART", params: [chan | _], prefix: prefix}}, state) do
    broadcast(state, chan, %{kind: :part, nick: nick_of(prefix), channel: chan})
    {:noreply, state}
  end

  def handle_info({:irc, _msg}, state), do: {:noreply, state}

  defp nick_of({:nick, n, _, _}), do: n
  defp nick_of({:server, s}), do: s
  defp nick_of(nil), do: "*"

  defp broadcast(state, channel, event) do
    topic = "grappa:network:#{state.network.id}/channel:#{channel}"
    Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, event})
  end
end
```

- [ ] **Step 10: Run session test — PASS**

### Sub-task 8d: Bootstrap on app start

- [ ] **Step 11: Implement `lib/grappa/bootstrap.ex`**

```elixir
defmodule Grappa.Bootstrap do
  @moduledoc """
  Reads the TOML config at startup and spawns one Grappa.Session
  per (user, network) under Grappa.SessionSupervisor.

  Phase 2 will replace this with dynamic per-user spawning on login.
  """

  use Task, restart: :transient
  require Logger

  alias Grappa.Config

  def start_link(_arg), do: Task.start_link(__MODULE__, :run, [])

  def run do
    path = Application.get_env(:grappa, :config_path)

    case Config.load(path) do
      {:ok, %Config{users: users}} ->
        Enum.each(users, fn user ->
          Enum.each(user.networks, fn net ->
            case Grappa.Session.Supervisor.start_session(%{user_name: user.name, network: net}) do
              {:ok, _pid} -> Logger.info("session spawned", user: user.name, network: net.id)
              {:error, err} -> Logger.error("session failed", error: inspect(err))
            end
          end)
        end)

      {:error, msg} ->
        Logger.warning("no config: #{msg}; running without sessions")
    end
  end
end
```

- [ ] **Step 12: Add `Grappa.Bootstrap` to application children**

```elixir
children = [
  Grappa.Repo,
  {Phoenix.PubSub, name: Grappa.PubSub},
  {Registry, keys: :unique, name: Grappa.SessionRegistry},
  {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one},
  GrappaWeb.Endpoint,
  Grappa.Bootstrap
]
```

- [ ] **Step 13: Manual end-to-end smoke**

Create `grappa.toml` at project root:

```toml
[server]
listen = "127.0.0.1:4000"

[[users]]
name = "vjt"

[[users.networks]]
id = "local"
host = "127.0.0.1"
port = 6667
tls = false
nick = "grappa-test"
autojoin = ["#test"]
```

Boot `iex -S mix`, connect a real IRC client to a local ergo, observe events flow into scrollback (`Grappa.Scrollback.fetch("local", "#test", nil, 10)`).

- [ ] **Step 14: Commit**

```bash
git add lib/grappa/irc/ lib/grappa/session/ lib/grappa/bootstrap.ex \
        lib/grappa/application.ex test/grappa/irc/ test/grappa/session/ \
        test/support/irc_server.ex
git commit -m "session: tokio-equiv GenServer-per-user + own IRC client + bootstrap"
```

---

## Task 9: Outbound JOIN/PART/PRIVMSG via the session

**Files:**
- Create: `lib/grappa_web/controllers/channels_controller.ex`
- Modify: `lib/grappa_web/controllers/messages_controller.ex` (route POST through session)
- Modify: `lib/grappa_web/router.ex`
- Create: `test/grappa_web/controllers/channels_controller_test.exs`

Until now POST-messages writes only to local scrollback. To actually send upstream:

- [ ] **Step 1: Helper to find session pid**

In `Grappa.Session.Server`:

```elixir
@spec whereis(String.t(), String.t()) :: pid() | nil
def whereis(user, net_id) do
  case Registry.lookup(Grappa.SessionRegistry, {user, net_id}) do
    [{pid, _}] -> pid
    [] -> nil
  end
end
```

- [ ] **Step 2: Update POST messages handler**

```elixir
case Scrollback.insert(attrs) do
  {:ok, msg} ->
    if pid = Grappa.Session.Server.whereis("vjt", network) do
      Grappa.Session.Server.send_privmsg(pid, channel, body)
    end
    broadcast(network, channel, msg)
    conn |> put_status(:created) |> json(serialize(msg))
  ...
end
```

(Phase 1 hardcodes user "vjt" — replaced in Phase 2 by authenticated user from session token.)

- [ ] **Step 3: Add ChannelsController**

```elixir
defmodule GrappaWeb.ChannelsController do
  use GrappaWeb, :controller

  alias Grappa.Session.Server, as: Session

  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def create(conn, %{"network_id" => net, "name" => chan}) when is_binary(chan) do
    case Session.whereis("vjt", net) do
      nil -> {:error, :not_found}
      pid ->
        Session.send_join(pid, chan)
        conn |> put_status(:accepted) |> json(%{ok: true})
    end
  end

  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def delete(conn, %{"network_id" => net, "channel_id" => chan}) do
    case Session.whereis("vjt", net) do
      nil -> {:error, :not_found}
      pid ->
        Session.send_part(pid, chan)
        conn |> put_status(:accepted) |> json(%{ok: true})
    end
  end
end
```

- [ ] **Step 4: Routes**

```elixir
post "/networks/:network_id/channels", ChannelsController, :create
delete "/networks/:network_id/channels/:channel_id", ChannelsController, :delete
```

- [ ] **Step 5: Tests** — same shape as Task 5/6 but use `IRCServer` helper to assert outbound bytes received.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa_web/controllers/channels_controller.ex \
        lib/grappa_web/controllers/messages_controller.ex \
        lib/grappa_web/router.ex test/grappa_web/controllers/channels_controller_test.exs \
        lib/grappa/session/server.ex
git commit -m "web+session: POST JOIN / DELETE PART / PRIVMSG round-trip upstream"
```

---

## Task 10: CI gates + Dialyzer + Sobelow + coverage

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Modify: `mix.exs` (Boundary annotations on contexts)

- [ ] **Step 1: Workflow**

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      MIX_ENV: test
    steps:
      - uses: actions/checkout@v4

      - uses: erlef/setup-beam@v1
        with:
          elixir-version: '1.19.5'
          otp-version: '28.5'

      - uses: actions/cache@v4
        with:
          path: |
            deps
            _build
            priv/plts
          key: ${{ runner.os }}-mix-${{ hashFiles('**/mix.lock') }}
          restore-keys: ${{ runner.os }}-mix-

      - name: Install deps
        run: mix deps.get --only test

      - name: Compile (warnings as errors)
        run: mix compile --warnings-as-errors

      - name: Format check
        run: mix format --check-formatted

      - name: Credo strict
        run: mix credo --strict

      - name: Sobelow security scan
        run: mix sobelow --config --exit Medium

      - name: Hex dependency audit
        run: mix hex.audit

      - name: Mix audit (CVE check)
        run: mix deps.audit

      - name: Doctor (doc + @spec coverage)
        run: mix doctor

      - name: Tests with coverage floor
        run: mix coveralls.json --warnings-as-errors

      - name: Coverage upload
        uses: codecov/codecov-action@v4
        with:
          files: ./cover/excoveralls.json
          fail_ci_if_error: true

      - name: Build docs (no warnings)
        run: mix docs

  dialyzer:
    runs-on: ubuntu-latest
    env:
      MIX_ENV: dev
    steps:
      - uses: actions/checkout@v4

      - uses: erlef/setup-beam@v1
        with:
          elixir-version: '1.19.5'
          otp-version: '28.5'

      - uses: actions/cache@v4
        with:
          path: |
            deps
            _build
            priv/plts
          key: ${{ runner.os }}-plt-${{ hashFiles('**/mix.lock') }}-v1
          restore-keys: ${{ runner.os }}-plt-

      - name: Install deps
        run: mix deps.get

      - name: Build PLT
        run: mix dialyzer --plt

      - name: Run Dialyzer
        run: mix dialyzer --format short
```

- [ ] **Step 2: Dependabot**

```yaml
version: 2
updates:
  - package-ecosystem: mix
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: "deps"
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    commit-message:
      prefix: "ci"
```

- [ ] **Step 3: Coverage floor**

In `mix.exs`:

```elixir
test_coverage: [tool: ExCoveralls, minimum_coverage: 80]
```

- [ ] **Step 4: Boundary contexts**

Annotate top of each context module:

```elixir
defmodule Grappa.Scrollback do
  use Boundary, deps: [Grappa.Repo], exports: [Message]
  ...
end
```

`Grappa.Session.Server` declares deps on `[Grappa.Scrollback, Grappa.IRC, Phoenix.PubSub]`. Cross-context calls outside declared deps fail compile.

- [ ] **Step 5: Commit**

```bash
git add .github/ mix.exs lib/grappa/scrollback.ex lib/grappa/session/server.ex \
        lib/grappa/irc/client.ex
git commit -m "ci: full gate pipeline + dependabot + Boundary annotations"
```

---

## Exit criteria for Phase 1

All of the following must hold before declaring Phase 1 done:

- [ ] `mix ci.check` (the alias from `mix.exs`) green locally and on CI.
- [ ] Coverage floor ≥ 80% across the app.
- [ ] Running `iex -S mix` against a local ergo with a TOML config file: sending a `PRIVMSG` upstream is persisted in sqlite and delivered as a `"event"` push on a Phoenix Channel subscriber.
- [ ] `curl /networks/:net/channels/:chan/messages?limit=N&before=<ts>` returns correctly paginated scrollback in descending `server_time` order.
- [ ] `POST /networks/:net/channels/:chan/messages` results in a `PRIVMSG` delivered upstream, a local scrollback row, AND a Channel event push.
- [ ] `POST /networks/:net/channels` + `DELETE /networks/:net/channels/:chan` JOIN and PART upstream.
- [ ] Killing a session GenServer (`Process.exit(pid, :kill)` from iex) leaves other sessions untouched and respawns nothing (`:transient` policy means it stays down on `:normal`, but `:kill` is treated as abnormal — verify the supervisor restarts it).
- [ ] Dialyzer reports zero warnings.
- [ ] Credo `--strict` reports zero issues.
- [ ] Sobelow reports no Medium-or-above findings.

---

## What comes next (not this plan)

- **Phase 2:** SASL bridge for login + NickServ proxy + Phoenix.Token sessions + multi-user isolation (replaces the hardcoded `"vjt"` user). Drops `Grappa.Bootstrap`'s static read of TOML and adds dynamic session spawning on login.
- **Phase 3:** cicchetto walking skeleton — Svelte/SolidJS PWA consuming the API + `phoenix.js` client for Channels.
- **Phase 5:** reconnect/backoff, scrollback eviction policy, allowlist enforcement, proper TLS verification, structured Logger metadata, telemetry metrics.
- **Phase 6:** the IRCv3 listener facade — map paginated scrollback to `CHATHISTORY` + expose `CAP LS` + SASL downstream. The parser from Task 8 is reused for the server side; a new `GrappaIRC.Listener` `Ranch`-based acceptor accepts inbound IRC connections, each handled by a `Grappa.IRC.ServerSession` GenServer that subscribes to the same PubSub topics the REST surface uses.
