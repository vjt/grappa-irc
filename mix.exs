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
        extras: ["README.md", "docs/DESIGN_NOTES.md"],
        source_url: "https://github.com/vjt/grappa-irc",
        homepage_url: "https://github.com/vjt/grappa-irc"
      ],
      sobelow: [
        verbose: true,
        exit: "Medium",
        skip: false
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
