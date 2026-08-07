defmodule Grappa.MixProject do
  use Mix.Project

  @app :grappa
  # #652 — the version is DECLARED ONCE in the repo-root `VERSION` file and read
  # here at BUILD time (compile-time `File.read!`, never a runtime read — the
  # #391 defect was a runtime read of this build file). Bumping `VERSION` no
  # longer touches `mix.exs`, so `Grappa.Deploy.Preflight` classifies a bump as
  # HOT instead of COLD (its `mix_deps?` clause) — a version bump keeps every
  # IRC session alive. `Grappa.Version` bakes the SAME file into a module
  # attribute so the reloaded beam carries the new number across a hot deploy.
  @version File.read!(Path.join(__DIR__, "VERSION")) |> String.trim()

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
      boundary: [default: [check: [in: true, out: true]]],
      releases: [
        grappa: [
          include_executables_for: [:unix],
          # #542 — deploy-time drift guard. After `:assemble`, assert the git
          # short-sha COMPILED into `Grappa.Version` equals the current `HEAD`,
          # else FAIL the release. This step runs inside EVERY `mix release
          # --overwrite` (the FreeBSD jail, the .deb, the AUR source pkg) — one
          # door, no substrate can skip it. #533 fixed the ROOT cause (the
          # @external_resource watch set that let the sha go stale); this is the
          # belt-and-suspenders that refuses to ship if a future gap reopens it,
          # because a version string that can be stale is worse than none — it
          # is trusted. See `assert_version_sha/1`.
          steps: [:assemble, &assert_version_sha/1],
          # `assemble` — Docker deploys never used `mix release`
          # (the container IS the runtime, see CLAUDE.md). The release
          # target is the FreeBSD bastille jail on m42 which has no
          # Docker. Build steps mirror what the container did at
          # boot: `mix deps.get --only prod`, `mix compile`,
          # `mix release --overwrite`, then `_build/prod/rel/grappa/bin/grappa
          # daemon` under an rc.d wrapper.
          applications: [runtime_tools: :permanent],
          # `config/runtime.exs` flips `code_reloader: true` on Phoenix's
          # Endpoint (CP23 cluster B2 — hot-reload story for Docker).
          # Phoenix marks that key as compile_env, so the release boot
          # check refuses to start when the runtime value doesn't match
          # the compile-time one (unset). Disabling the check is the
          # release-doc-recommended escape hatch for genuinely-meant
          # compile_env overrides. The Docker path doesn't hit this
          # because it boots via `mix phx.server`, not via the release
          # boot script.
          validate_compile_env: false
        ]
      ]
    ]
  end

  # Elixir 1.19 deprecated `:preferred_cli_env` in `project/0` in favor
  # of a dedicated `cli/0` callback (key renamed to `:preferred_envs`).
  def cli do
    [
      preferred_envs: [
        coveralls: :test,
        "coveralls.detail": :test,
        "coveralls.html": :test,
        "coveralls.json": :test,
        "coveralls.lcov": :test
      ]
    ]
  end

  def application do
    [
      mod: {Grappa.Application, []},
      extra_applications: [:logger, :runtime_tools, :ssl, :crypto, :inets]
    ]
  end

  # #542 — `mix release` step (runs after `:assemble`). Compares the git
  # short-sha COMPILED into the just-built `Grappa.Version` (`@git_facts`)
  # against the CURRENT `HEAD`, and raises — failing the release — on drift.
  # The verdict matrix (skip-on-no-git-but-log, FAIL on a git build with a
  # missing/mismatched sha) is the pure `Grappa.Version.verify_build_sha/2`,
  # unit-tested in `test/grappa/version_test.exs`; this shell only resolves
  # HEAD, logs, and raises.
  #
  # `Grappa.Version` is reached through a variable (`version = Grappa.Version`)
  # on purpose: `mix.exs` is compiled by Mix BEFORE the app, so a static call
  # would emit an "undefined function" xref warning on every mix invocation.
  # The capture in `steps:` is lazy — the app is compiled by the time this runs.
  defp assert_version_sha(release) do
    version = Grappa.Version
    head_sha = head_short_sha()

    case version.verify_build_sha(head_sha) do
      :ok ->
        Mix.shell().info("version guard (#542): Grappa.Version sha matches HEAD #{head_sha}")
        release

      {:skip, :no_git} ->
        # Log-honesty: a fast path states what it OBSERVED, never a silent no-op.
        # Report the bare version from `release.version` (the %Mix.Release{}
        # field) — NOT `Grappa.Version.base/0`, which returns "" unless `:grappa`
        # is loaded into the mix VM, and would emit an empty version on this very
        # honesty-logging path (the AUR-tarball substrate exercises it).
        Mix.shell().info(
          "version guard (#542): no .git at build — artifact reports the bare " <>
            "#{release.version} (package/tarball); no HEAD to verify against"
        )

        release

      {:error, {:stale, compiled, head}} ->
        Mix.raise(
          "version guard (#542): compiled Grappa.Version sha #{compiled} != HEAD #{head} — " <>
            "Version.beam is STALE (mix compile did not re-snapshot the git ref). Refusing to " <>
            "assemble a release that would misreport CTCP VERSION — clean-rebuild and retry."
        )

      {:error, :sha_snapshot_degraded} ->
        Mix.raise(
          "version guard (#542): git was present at build but Grappa.Version snapshotted no sha " <>
            "(reports -dev) — a trusted-but-unverifiable version. Refusing to assemble."
        )

      {:error, :head_unresolved} ->
        Mix.raise(
          "version guard (#542): cannot resolve HEAD via `git rev-parse` though the build carries " <>
            "a compiled sha — refusing to ship a version that can't be verified."
        )
    end
  end

  # Current `HEAD` short-sha, or `nil` when git can't answer. Mirrors
  # `Grappa.Version.GitProbe.git/2`: `env: []` (git introspection needs none of
  # grappa's secrets, and a cleared env keeps them out of the subprocess), and a
  # `rescue`/`catch` so a MISSING git binary degrades to `nil` (→ the clean
  # `:head_unresolved` verdict) rather than a raw `:enoent` stack trace — a
  # clean-verdict guard deserves a clean failure.
  defp head_short_sha do
    case System.cmd("git", ["rev-parse", "--short", "HEAD"], env: [], stderr_to_stdout: true) do
      {out, 0} -> String.trim(out)
      {_, _} -> nil
    end
  rescue
    _ -> nil
  catch
    _, _ -> nil
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
      # WebAuthn relying-party verification for account passkeys (#442).
      # Browser ceremony remains in cicchetto; this dependency verifies
      # registration attestations and authentication assertions server-side.
      {:wax_, "~> 0.7.0"},

      # ── Tooling (compile-time / dev-only)
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:sobelow, "~> 0.14", only: [:dev, :test], runtime: false},
      {:mix_audit, "~> 2.1", only: [:dev, :test], runtime: false},
      {:doctor, "~> 0.22", only: [:dev, :test], runtime: false},
      {:boundary, "~> 0.10", runtime: false},
      {:ex_doc, "~> 0.34", only: [:dev], runtime: false},
      {:mix_test_watch, "~> 1.4", only: [:dev, :test], runtime: false},
      {:observer_cli, "~> 2.0", only: [:dev]},

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
        "cmd mix deps.audit",
        # hex.audit is advisory-only (non-fatal). FOUR advisories sit under
        # this derogation today (OSV, 2026-08-06), not the two it was written
        # for — it was never re-read as new ones landed:
        #
        #   cowlib 2.18.0
        #     CVE-2026-43966  response splitting via non-VCHAR bytes in
        #                     cow_http_struct_hd:escape_string/2 (CWE-113,
        #                     SI:L) — NO fixed release
        #     CVE-2026-43969  request-cookie injection in cow_cookie:cookie/1
        #                     (CWE-93, AV:L) — NO fixed release
        #     CVE-2026-59248  unbounded HPACK/QPACK prefixed-integer decode,
        #                     memory-exhaustion DoS (CWE-770, AV:N VA:H)
        #                     — FIXED in cowlib 2.19.0, not taken (#149)
        #   cowboy 2.17.0
        #     CVE-2026-65624  max_headers bypass via duplicate header names,
        #                     memory exhaustion (CWE-770, AV:N VA:L)
        #                     — FIXED in cowboy 2.18.0, not taken (#149)
        #
        # WHY THE DEROGATION HOLDS, and it is not the severities: cowboy and
        # cowlib enter the tree ONLY through `bypass` (`only: :test`, via
        # plug_cowboy). Production serves on Bandit, and a prod release built
        # at MIX_ENV=prod contains neither — so none of the four is reachable
        # by a deployed grappa. The pre-existing note claimed both unfixable
        # advisories were cow_cookie COMPOSITION issues; 43966 is a response-
        # header path, so "we never compose request cookies" never covered it.
        # Reachability does.
        #
        # WHAT MAKES IT FALL: (a) cowlib shipping a release that fixes 43966 +
        # 43969 — every version >= 2.9.0 is affected today, 2.19.0 included,
        # so no bump can close them and hex.audit has no per-advisory ignore
        # to express the N/A; (b) cowboy/cowlib becoming reachable at runtime
        # (a non-test dep, or a move off Bandit), which voids the whole
        # argument regardless of what is fixed. Either one, and the `|| true`
        # goes — that is #149. deps.audit above stays the hard CVE gate, and
        # this mirrors `continue-on-error` on the CI step.
        "cmd sh -c 'mix hex.audit || true'",
        "cmd mix sobelow --config --exit Medium",
        # #621 — doctor shells out to MIX_ENV=test, like the test step below
        # and for a related reason: this alias is pinned to :dev (credo /
        # sobelow / ex_doc are dev-or-test deps), and in :dev doctor lies.
        # It counts a module's functions from the SOURCE AST but reads
        # doc/spec presence from the compiled BEAM, so everything inside an
        # `if Mix.env() == :test do … end` block is counted-but-unscored:
        # present in the count, absent from the beam, filed as "No Docs" AND
        # "No Specs" even with `@doc false` + a full `@spec`. Nine modules in
        # `lib/` carry such a seam today. `Repo.BusyRetry` is the closest to
        # the floor: measured, :dev scores it 43% doc / 43% spec (4 phantom
        # "No Docs" AND 4 phantom "No Specs") where :test scores it 100/100.
        # It DID cross doctor's 40% floor once — at bf74899e, where
        # `arm_faults` had two arities, so 3 documented of 8 = 38%, red. The
        # next commit of the same #594, 2b42190a, collapsed those arities for
        # an unrelated design reason (a default argument in disguise) and took
        # it back to 43%. So the gate is GREEN on main today and this change
        # fixes no live red — it removes a 3-point margin under which the next
        # seam to grow lands, on a lie the test-env doctor never tells.
        #
        # :test loses no coverage — it is a strict superset. `elixirc_paths`
        # adds `test/support` there (which is why the GH workflow's single
        # doctor step, `MIX_ENV: test`, catches test-support modules the :dev
        # run never scanned — the #75 parity gap that shipped 4 red commits,
        # 2eed58ca), and NO function in `lib/` is gated on `Mix.env() == :dev`,
        # so nothing exists that :dev can see and :test cannot.
        #
        # Raising the 40% floor to make BusyRetry fit was rejected: the count
        # is what is dishonest, not the threshold.
        "cmd env MIX_ENV=test mix doctor",
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
