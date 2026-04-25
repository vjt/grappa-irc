defmodule Grappa.MixProject do
  use Mix.Project

  @app :grappa
  @version "0.0.1"

  def project do
    [
      app: @app,
      version: @version,
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      compilers: [:boundary] ++ Mix.compilers(),
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
        skip: false,
        # Phase 5 (hardening) re-enables HTTPS enforcement.
        # See CLAUDE.md "Security" + DESIGN_NOTES TLS posture.
        ignore: ["Config.HTTPS"]
      ],
      boundary: [default: [check: [in: true, out: true]]],
      releases: [
        grappa: [
          include_executables_for: [:unix],
          applications: [runtime_tools: :permanent],
          steps: [:assemble, :tar]
        ]
      ]
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
      {:jason, "~> 1.4"},
      {:toml, "~> 0.7"},
      {:req, "~> 0.5"},
      {:argon2_elixir, "~> 4.1"},
      {:telemetry, "~> 1.3"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.1"},
      {:recon, "~> 2.5"},

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
        # Compile first with warnings-as-errors so the Boundary compiler
        # (added to `compilers/0`) fails the build on cross-boundary
        # violations rather than printing them as advisory warnings.
        # `cmd mix compile ...` shells out to a fresh mix process —
        # running `compile --warnings-as-errors` inline corrupts the
        # archive table for subsequent hex.* tasks in the alias chain.
        "cmd mix compile --warnings-as-errors",
        "format --check-formatted",
        "credo --strict",
        "deps.audit",
        "hex.audit",
        "sobelow --config --exit Medium",
        "doctor",
        # Coverage is a CI-only step (mix coveralls.json in the workflow);
        # local runs would need MIX_ENV=test for excoveralls to load.
        # `cmd MIX_ENV=test mix test ...` shells out so MIX_ENV is set
        # for the test run — `mix test` from inside an alias inherits
        # the parent's env (here :dev from ci.check), and then Repo
        # picks up the dev pool instead of Sandbox. Spawning a fresh
        # mix process is the canonical workaround for this Mix quirk.
        "cmd env MIX_ENV=test mix test --warnings-as-errors",
        "dialyzer",
        "docs"
      ]
    ]
  end
end
