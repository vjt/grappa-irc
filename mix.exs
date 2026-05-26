defmodule Grappa.MixProject do
  use Mix.Project

  @app :grappa
  @version "0.3.0"

  def project do
    [
      app: @app,
      version: @version,
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      compilers: [:boundary] ++ Mix.compilers(),
      # Elixir 1.18+ Mix listener: lets Phoenix.CodeReloader notice
      # concurrent recompiles (e.g. `mix compile` from another shell
      # against the same _build/) so the next /admin/reload picks up
      # the new beams. Phoenix prints a warning at reload time if this
      # is missing (CP23 cluster `code-reload` B3 wiring).
      listeners: [Phoenix.CodeReloader],
      # Elixir 1.19 introduced explicit test discovery filters. Without
      # this, ExUnit warns on every non-`_test.exs` file under `test/`
      # (test/support/data_case.ex etc.).
      test_load_filters: [&String.ends_with?(&1, "_test.exs")],
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      test_coverage: [tool: ExCoveralls],
      preferred_cli_env: [
        coveralls: :test,
        "coveralls.detail": :test,
        "coveralls.html": :test,
        "coveralls.json": :test,
        "coveralls.lcov": :test
      ],
      dialyzer: [
        plt_add_apps: [:ex_unit, :mix],
        plt_local_path: "priv/plts",
        plt_core_path: "priv/plts",
        flags: [
          :error_handling,
          :extra_return,
          :missing_return,
          :underspecs,
          :unmatched_returns,
          :unknown
        ]
      ],
      docs: [
        main: "Grappa",
        extras: ["README.md", "docs/DESIGN_NOTES.md", "LICENSE"],
        source_url: "https://github.com/vjt/grappa-irc",
        homepage_url: "https://github.com/vjt/grappa-irc"
      ],
      sobelow: [
        verbose: true,
        exit: "Medium",
        # `skip: true` honors `@sobelow_skip ["Check.Name"]` module
        # attributes on individual functions — used to suppress
        # false-positive traversal findings in `GrappaWeb.UploadsController`
        # + `GrappaWeb.Admin.UploadsController` where the path source
        # is base32-validated by `Grappa.Uploads.storage_path/2` or
        # synthesized by `Plug.Parsers :multipart`. Justification
        # comments live alongside each `@sobelow_skip` attribute.
        skip: true,
        # Phase 5 (hardening) re-enables HTTPS enforcement.
        # See CLAUDE.md "Security" + DESIGN_NOTES TLS posture.
        ignore: ["Config.HTTPS"]
      ],
      boundary: [default: [check: [in: true, out: true]]]
    ]
  end

  def application do
    [
      mod: {Grappa.Application, []},
      extra_applications: [:logger, :runtime_tools, :ssl, :crypto, :inets]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # ── Runtime
      {:phoenix, "~> 1.8.0"},
      {:phoenix_pubsub, "~> 2.1"},
      {:bandit, "~> 1.6"},
      {:plug, "~> 1.16"},
      {:ecto_sql, "~> 3.12"},
      {:ecto_sqlite3, "~> 0.22"},
      # CVE GHSA-rhv4-8758-jx7v (moderate DoS via unbounded exponent in
      # `Decimal.new`) — vulnerable < 3.0.0. ecto + ecto_sql + mix_audit
      # all accept `~> 3.0`; doctor's pin `~> 2.0` would otherwise force
      # the solver to 2.x. We hold no direct Decimal call sites
      # (transitive-only dep), so `override: true` is safe.
      {:decimal, "~> 3.0", override: true},
      {:jason, "~> 1.4"},
      {:req, "~> 0.5"},
      {:argon2_elixir, "~> 4.1"},
      {:cloak, "~> 1.1"},
      {:cloak_ecto, "~> 1.3"},
      # Web Push delivery (RFC 8030 / VAPID RFC 8292). Picked over
      # `web_push_encryption` (last release 2021-09-15, no native
      # 410-Gone signal) because:
      #   * Active maintenance — 0.8.0 released 2026-05-04.
      #   * `send_notification/2` returns `{:error, :expired}` for
      #     404/410, mapping cleanly onto `Push.delete_dead/1`.
      #   * Reads `vapid_{public,private,subject}_key` from
      #     `Application.get_env/2` at request time, so
      #     `config/runtime.exs` can populate from env vars at boot
      #     without any compile-time leakage.
      # Push notifications cluster B2 (2026-05-14).
      {:web_push_elixir, "~> 0.8"},
      {:telemetry, "~> 1.3"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.1"},
      {:recon, "~> 2.5"},
      # Honor X-Forwarded-For / X-Real-IP from the nginx reverse proxy
      # so `conn.remote_ip` resolves to the real client and not the
      # docker-bridge nginx IP. The package's default proxy allowlist
      # already covers the private docker bridge ranges (127/8, 10/8,
      # 172.16/12, 192.168/16, ::1/128, fc00::/7) — no explicit CIDR
      # config needed for the single-hop nginx→Phoenix topology.
      # Wired in `lib/grappa_web/endpoint.ex` between RequestId and
      # Telemetry so every downstream log + telemetry event sees the
      # rewritten IP.
      {:remote_ip, "~> 1.2"},

      # ── Tooling (compile-time / dev-only)
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:sobelow, "~> 0.14", only: [:dev, :test], runtime: false},
      {:mix_audit, "~> 2.1", only: [:dev, :test], runtime: false},
      {:doctor, "~> 0.22", only: [:dev, :test], runtime: false},
      {:boundary, "~> 0.10", runtime: false},
      {:ex_doc, "~> 0.34", only: [:dev], runtime: false},
      {:mix_test_watch, "~> 1.4", only: [:dev, :test], runtime: false},
      {:observer_cli, "~> 1.8", only: [:dev]},

      # ── Test
      {:stream_data, "~> 1.3", only: [:dev, :test]},
      {:mox, "~> 1.2", only: :test},
      {:bypass, "~> 2.1", only: :test},
      {:ex_machina, "~> 2.8", only: :test},
      {:excoveralls, "~> 0.18", only: :test}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.setup"],
      "ecto.setup": ["ecto.create --quiet", "ecto.migrate --quiet"],
      "ecto.reset": ["ecto.drop --quiet", "ecto.setup"],
      test: ["ecto.create --quiet", "ecto.migrate --quiet", "test"],
      "ci.check": [
        # Each step shells out via `cmd` so the alias chain HALTS on
        # any non-zero exit. Pre-2026-05-26 (cluster e2e-revive-skips
        # post-mortem): in-alias steps (`format --check-formatted`,
        # `credo --strict`, `doctor`, etc.) ran via native task
        # invocation, which does NOT propagate exit codes to the
        # alias-level failure. A failing `doctor` exited 1 internally
        # but the alias kept going and reported success, masking the
        # failure from `scripts/check.sh`. CI caught it because its
        # workflow YAML invokes `mix doctor` as a separate step where
        # exit propagation works. `mix cmd` explicitly aborts on
        # non-zero per its docs — wrapping every step in `cmd` is the
        # idiomatic fix.
        #
        # `cmd mix compile --warnings-as-errors` must stay first so
        # Boundary compiler (added to `compilers/0`) fails the build
        # on cross-boundary violations rather than printing them as
        # advisory warnings.
        "cmd mix compile --warnings-as-errors",
        "cmd mix format --check-formatted",
        "cmd mix credo --strict",
        # `--ignore-advisory-ids GHSA-g2wm-735q-3f56` skips the LOW-severity
        # cowlib cookie-injection advisory that has NO patched version
        # ("First patched versions:" empty in the advisory). cic does NOT
        # call cow_cookie:cookie/1 (no request-cookie composition path; we
        # only consume Cookie headers via Plug). Per CLAUDE.md "Medium-
        # or-above findings fail the build" — LOW with no fix is filtered.
        # Re-evaluate when cowlib publishes a patch (revisit the
        # vulnerable-version range above).
        "cmd mix deps.audit --ignore-advisory-ids GHSA-g2wm-735q-3f56",
        "cmd mix hex.audit",
        "cmd mix sobelow --config --exit Medium",
        "cmd mix doctor",
        # Coverage is a CI-only step (mix coveralls.json in the workflow);
        # local runs would need MIX_ENV=test for excoveralls to load.
        # `cmd env MIX_ENV=test mix test ...` shells out so MIX_ENV is set
        # for the test run — `mix test` from inside an alias inherits
        # the parent's env (here :dev from ci.check), and then Repo
        # picks up the dev pool instead of Sandbox. Spawning a fresh
        # mix process is the canonical workaround for this Mix quirk.
        "cmd env MIX_ENV=test mix test --warnings-as-errors",
        "cmd mix dialyzer",
        "cmd mix docs"
      ]
    ]
  end
end
