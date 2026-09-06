defmodule Grappa.HotReload do
  @moduledoc """
  Hot-reload of the app's modules in the running BEAM — the context
  behind `POST /admin/reload` (see `GrappaWeb.AdminController` for
  the endpoint story and the why-not-`Phoenix.CodeReloader` history).

  ## One uniform walk, by absolute path

  `reload_modified/0` walks the grappa app's ebin directory and, per
  beam file: loads it if the module was never loaded; soft-purges +
  reloads it if the on-disk md5 differs from the loaded version's
  `module_info(:md5)`; skips it otherwise. Dependencies are
  deliberately out of scope — a dep change means `mix.lock` changed,
  and the deploy preflight forces COLD for that class, so the app's
  own ebin is the complete hot-reload surface.

  Loading goes through `:code.load_abs/1` with the explicit beam
  path, never `:code.load_file/1`. Three live repros (2026-06-10)
  drove this design:

  * `:code.modified_modules/0` only compares LOADED beams against
    disk — a hot deploy that ADDS a module is invisible to it, and
    releases run embedded mode (no lazy loading), so the first call
    into the new module crashed `:undef`.
  * The OTP 26+ cached code path does not see files added to a
    directory after boot — `:code.load_file/1` returned `:nofile`
    for a beam demonstrably sitting in a path-member dir. This bites
    FOREVER (until cold restart) for any module first hot-deployed
    post-boot, including this module's own first update.
  * md5 comparison replaces `:code.modified_modules/0` because the
    latter resolves through the same cached path.

  ## soft-purge, never purge

  Erlang keeps at most TWO versions of a module: current and old.
  Loading shifts current → old — which means a module hot-reloaded
  once already has both slots full, and the SECOND hot reload fails
  `{:error, :not_purged}` until the old version is purged (also hit
  live 2026-06-10, while the endpoint's own doc claimed it purged).

  The purge MUST be `:code.soft_purge/1`, not `:code.purge/1`: hard
  purge KILLS every process still executing old code — on an
  always-on bouncer that's dropped IRC sessions, silently, from an
  endpoint whose whole purpose is to avoid restarts. soft_purge
  refuses instead, and the refusal is surfaced as
  `{mod, :old_code_in_use}` in `failed` so the operator decides
  (usually: wait for the process to make a fully-qualified call and
  retry, or schedule a cold window).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Deploy.MigrationAudit, Grappa.Deploy.Preflight, Grappa.Repo],
    exports: []

  alias Grappa.Deploy.{MigrationAudit, Preflight}

  @typedoc "Per-module failure: soft-purge refusal or load error."
  @type failure :: {module(), :old_code_in_use | term()}

  @type result :: %{reloaded: [module()], failed: [failure()]}

  @typedoc "Applied migration versions plus the module-reload outcome."
  @type migrate_result :: %{
          migrated: [non_neg_integer()],
          reloaded: [module()],
          failed: [failure()]
        }

  @typedoc """
  What the running node loads from, versus what the build just wrote.

  `booted` is the vsn carried in the live node's own code path; `built` is
  the vsn the release metadata on disk names, `nil` when it could not be
  read. `lib_dir` is the directory `reload_modified/0` would have walked.
  """
  @type code_path_drift :: %{
          booted: String.t(),
          built: String.t() | nil,
          lib_dir: Path.t()
        }

  @typedoc """
  Refusal to migrate. Either the named migration files are pending and at
  least one of their ops is contract (or unprovable), a version is
  claimed by two files (#1348), or the fresh beams landed in a lib
  directory the running node never reads (#1850). Nothing ran, in all
  three cases — and they need DIFFERENT operator moves: the first and the
  third are what a cold deploy is for, the second is a repo defect a cold
  deploy walks straight back into.
  """
  @type refusal ::
          {:contract_migrations, [Path.t()]}
          | {:duplicate_migration_versions, [MigrationAudit.duplicate()]}
          | {:stale_code_path, code_path_drift()}

  @doc """
  Apply pending migrations on the live pool, THEN reload modules (#41).

  Returns `{:ok, %{migrated: versions, reloaded: mods, failed: fails}}`,
  or `{:error, {:contract_migrations, files}}` having done NOTHING.

  ## Why in-process, and in this order

  This runs in the live BEAM with `Grappa.Repo` already supervised, so
  `Ecto.Migrator.run/3` uses the pool that is already open — ONE sqlite
  writer, no eval node. Deliberately NOT `Ecto.Migrator.with_repo/2`
  (`Grappa.Release.migrate/0`'s shape): that one STARTS and STOPS the
  repo, which here would fight the supervised one.

  **Migrate first, load second.** For an expand migration the still-loaded
  old code cannot reference the new column, so it keeps running safely
  while the DDL commits; only then does new code — which does reference
  it — get loaded. The reverse order is the 500-on-first-query window.

  **A failing migration must not reload.** No rescue here on purpose:
  `Ecto.Migrator` raising propagates out through the controller as a
  5xx, the transaction rolls back, old code is still loaded and still
  correct, and the deploy script's `curl -fsS` fails LOUDLY. Rescuing
  would convert a schema failure into a 200 with new code on stale
  schema — the exact silent-swallow CLAUDE.md forbids at boundaries.

  ## Why it refuses instead of trusting the deploy-time verdict

  `Grappa.Deploy.Preflight` classifies the DIFF being deployed. What is
  PENDING is a different set: `--force-hot` skips preflight entirely,
  and a migration added in an earlier undeployed commit is pending
  without appearing in this diff. Running `:up, all: true` on that set
  unconditionally is what would make "hot also hardens --force-hot" a
  session-dropping vector. So the last line of defence is HERE, where
  the pending set is actually observable, and it re-uses the SAME pure
  classifier the deploy script consults — one rule, both doors.
  """
  @spec migrate_and_reload() :: {:ok, migrate_result()} | {:error, refusal()}
  def migrate_and_reload, do: migrate_and_reload(Grappa.Repo, &reload_modified/0)

  @doc """
  `migrate_and_reload/0` against an explicit repo, with only the
  module-reload injected.

  The REPO is a parameter so the test suite can drive this exact code —
  the real gate, the real `Ecto.Migrator.run/3`, the real pending
  enumeration — against a live supervised pool on a scratch sqlite file
  (`test/grappa/migrations/hot_deploy_migrate_test.exs`). Injecting the
  migration itself, as an earlier shape did, proves the ORDER and the
  abort but never that the migrate works against a live pool at all;
  those are two different questions.

  `reload_fn` stays injected on purpose and is NOT the same compromise:
  walking the real app ebin from a test would reload — and so
  de-instrument — every module mid-run and corrupt coverage (the same
  reason `reload_modified/0` itself has no direct test). Passing a
  probe here is also how the ORDER gets measured for real: the probe
  asserts the new column is already visible by the time it runs.
  """
  @spec migrate_and_reload(module(), (-> result())) ::
          {:ok, migrate_result()} | {:error, refusal()}
  def migrate_and_reload(repo, reload_fn) when is_atom(repo) and is_function(reload_fn, 0) do
    # The CODE-PATH audit runs before even the migration audit (#1850). If
    # the build wrote its beams into a sibling directory, every module this
    # call could load is already stale, so migrating first would commit DDL
    # under code that a cold restart is about to replace anyway — and the
    # 200 that followed would tell the deploy script "hot deploy complete"
    # over a node that loaded nothing.
    case audit_code_path(app_lib_dir()) do
      :ok -> audit_migrations(repo, reload_fn)
      {:error, _} = stale -> stale
    end
  end

  defp audit_migrations(repo, reload_fn) do
    # The audit runs FIRST, and not only because a duplicate is the worse
    # defect: `pending_migration_files/1` below matches `[path] =
    # Path.wildcard(…)` per pending version, so a duplicate that is still
    # PENDING would blow up there as a MatchError. Auditing first turns
    # that crash into a refusal that names the two files.
    case MigrationAudit.check(repo) do
      :ok -> migrate_expand_only(repo, reload_fn)
      {:error, duplicates} -> {:error, {:duplicate_migration_versions, duplicates}}
    end
  end

  defp migrate_expand_only(repo, reload_fn) do
    case contract_migrations(repo) do
      [] ->
        migrated = Ecto.Migrator.run(repo, :up, all: true)
        %{reloaded: reloaded, failed: failed} = reload_fn.()
        {:ok, %{migrated: migrated, reloaded: reloaded, failed: failed}}

      contract ->
        {:error, {:contract_migrations, contract}}
    end
  end

  @doc """
  The pending migrations whose up-direction is contract or unprovable —
  the ones that must not be applied under a live BEAM.
  """
  @spec contract_migrations(module()) :: [Path.t()]
  def contract_migrations(repo) when is_atom(repo) do
    Enum.filter(pending_migration_files(repo), &contract_migration?/1)
  end

  @doc """
  Paths of the migrations that exist on disk and are not yet applied.

  Release-safe: `priv/repo/migrations/*.exs` ships inside the release's
  priv dir (that is how `Grappa.Release.migrate/0` runs at all), so the
  sources the classifier reads are present on every substrate.
  """
  @spec pending_migration_files(module()) :: [Path.t()]
  def pending_migration_files(repo) when is_atom(repo) do
    dir = Ecto.Migrator.migrations_path(repo)

    for {:down, version, _} <- Ecto.Migrator.migrations(repo) do
      # A `:down` status is derived FROM a file on disk, so exactly one
      # match is the only possible outcome; the MatchError if that ever
      # stops holding is the loud failure we want, not a silent skip.
      [path] = Path.wildcard(Path.join(dir, "#{version}_*.exs"))
      path
    end
  end

  defp contract_migration?(path) do
    Preflight.classify_migration(File.read!(path)) == :cold
  end

  @doc """
  Refuse a hot reload whose fresh beams landed somewhere the running node
  does not read (#1850).

  Takes the lib directory the node resolves for `:grappa` — the parent of
  the ebin `reload_modified/0` walks — and answers `:ok` or
  `{:error, {:stale_code_path, drift}}`.

  ## The silence this breaks

  On the two `mix release` substrates the code path is
  `lib/grappa-<vsn>/ebin`, and `:code.lib_dir/1` resolves it to the **boot**
  directory forever. A `VERSION`-only bump moves the build's output to
  `lib/grappa-<new>/ebin`, so `reload_modified/0` walks the stale tree,
  diffs it against itself and answers `%{reloaded: [], failed: []}` — a
  shape indistinguishable from "nothing to do". `Grappa.Deploy.Preflight`
  PREVENTS that by classifying a `VERSION` diff COLD, but prevention is
  not detection: `--force-hot` skips preflight entirely, and a diff range
  that misses the bump has nothing to classify. Production served the old
  BEAM under the new git history for ~6.5 hours on 2026-08-13 that way,
  and the deploy printed success. Same posture as
  `migrate_and_reload/2`'s pending-migration gate: the last line of
  defence belongs HERE, where the code path is actually observable.

  ## Why the release metadata, and not the sibling directories

  Measured on a real `mix release --overwrite` (2026-09-06, isolated build
  cache): a bump leaves the old `lib/grappa-<old>` **in place**, mtime
  untouched, and adds `lib/grappa-<new>` beside it. Stale lib dirs
  therefore accumulate forever, and "more than one `grappa-*` sibling"
  would refuse every hot deploy on a jail that has ever been bumped —
  a permanent false COLD.

  What DOES move is `<rel>/releases/start_erl.data`, rewritten to
  `"<erts_vsn> <release_vsn>"` on every assemble (`16.4.0.4 1.5.1` →
  `16.4.0.4 9.9.9` across the two measured builds). Comparing it against
  the vsn in the node's own code path is exact and carries no heuristic.

  ## Inert where the layout cannot drift

  Docker execs `mix phx.server` over a bind-mounted tree, where the lib
  dir is `_build/<env>/lib/grappa` — no vsn in the path, so there is
  nothing to compare and the fresh beams always land where the node is
  already looking. That case returns `:ok` from the FIRST clause, by
  construction rather than by a substrate flag.

  A versioned path whose `start_erl.data` cannot be read or parsed
  refuses. The path says "this is a mix release", so the metadata is
  expected; reading `:ok` out of its absence would restore exactly the
  silence this audit exists to break.
  """
  @spec audit_code_path(Path.t()) :: :ok | {:error, {:stale_code_path, code_path_drift()}}
  def audit_code_path(lib_dir) when is_binary(lib_dir) do
    case booted_vsn(lib_dir) do
      nil -> :ok
      booted -> compare_vsn(lib_dir, booted, built_vsn(lib_dir))
    end
  end

  defp compare_vsn(_, vsn, vsn), do: :ok

  defp compare_vsn(lib_dir, booted, built),
    do: {:error, {:stale_code_path, %{booted: booted, built: built, lib_dir: lib_dir}}}

  # The vsn a `mix release` layout carries in the code path itself
  # (`lib/grappa-1.5.1`); `nil` for the unversioned Docker / source-checkout
  # layout (`_build/<env>/lib/grappa`).
  defp booted_vsn(lib_dir) do
    case Path.basename(lib_dir) do
      "grappa-" <> vsn -> vsn
      _ -> nil
    end
  end

  # The vsn the release metadata names — what the last `mix release
  # --overwrite` produced. `nil` when the file is missing or is not the
  # documented `"<erts_vsn> <release_vsn>"` pair, which is a refusal (see
  # the @doc): on a versioned path, unreadable metadata is doubt, not
  # absence of drift.
  defp built_vsn(lib_dir) do
    # `Path.dirname/1` twice, NOT `Path.join([lib_dir, "..", "..", …])`:
    # dirname is lexical, while `..` is resolved by the OS at open time and
    # is ENOENT when a path component is missing. The component missing is
    # exactly the case that matters — a boot dir the build removed — and
    # the naive form lost the new vsn there while still refusing. Caught by
    # `code_path_audit_test.exs`'s vanished-boot-dir case, not reasoned out.
    release_root = lib_dir |> Path.dirname() |> Path.dirname()

    with {:ok, contents} <- File.read(Path.join([release_root, "releases", "start_erl.data"])),
         [_, vsn] <- contents |> String.trim() |> String.split(" ", trim: true) do
      vsn
    else
      _ -> nil
    end
  end

  @doc """
  Walk the grappa app's ebin and reload every new or changed module.
  The .beam files must already be fresh on disk — that's the deploy
  script's job (see `GrappaWeb.AdminController` moduledoc for the
  per-substrate split).
  """
  @spec reload_modified() :: result()
  def reload_modified do
    app_lib_dir() |> Path.join("ebin") |> reload_from()
  end

  # The one derivation of the running node's grappa lib directory — the
  # ebin `reload_modified/0` walks lives under it, and `audit_code_path/1`
  # reads the vsn off it. `:code.lib_dir/1` resolves to the BOOT directory,
  # which is the whole point of the audit.
  defp app_lib_dir, do: :grappa |> :code.lib_dir() |> to_string()

  @doc """
  Reload every beam under `ebin_dir` that is new (module not loaded)
  or changed (on-disk md5 differs from the loaded version). Unchanged
  modules are untouched.
  """
  @spec reload_from(Path.t()) :: result()
  def reload_from(ebin_dir) do
    results =
      for beam <- Path.wildcard(Path.join(ebin_dir, "*.beam")),
          mod = beam |> Path.basename(".beam") |> String.to_atom(),
          new_or_changed?(mod, beam) do
        reload_one(mod, beam)
      end

    %{
      reloaded: for({mod, :ok} <- results, do: mod),
      failed: for({mod, {:error, reason}} <- results, do: {mod, reason})
    }
  end

  defp new_or_changed?(mod, beam) do
    case :code.is_loaded(mod) do
      false ->
        true

      {:file, _} ->
        case :beam_lib.md5(String.to_charlist(beam)) do
          {:ok, {^mod, disk_md5}} -> disk_md5 != apply(mod, :module_info, [:md5])
          # Unreadable/mismatched beam: surface via the load attempt
          # rather than silently skipping a file that claims to be
          # this module.
          _ -> true
        end
    end
  end

  defp reload_one(mod, beam) do
    if :code.soft_purge(mod) do
      # load_abs wants the path sans ".beam" extension. Never
      # :code.load_file/1 here — see moduledoc (cached code path is
      # blind to post-boot files).
      beam_sans_ext = beam |> Path.rootname() |> String.to_charlist()

      case :code.load_abs(beam_sans_ext) do
        {:module, ^mod} -> {mod, :ok}
        {:error, reason} -> {mod, {:error, reason}}
      end
    else
      {mod, {:error, :old_code_in_use}}
    end
  end
end
