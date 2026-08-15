defmodule Grappa.Deploy.Preflight do
  @moduledoc """
  Single source of truth for deploy hot-vs-cold classification —
  `scripts/deploy.sh` (Docker) and `infra/freebsd/deploy.sh` (jail)
  both delegate here.

  Replaces the bash-grep preflight (and the awk state-block helper) that
  REV-C codebase review flagged as fragile (C4) and incomplete (H20):

  * **C4** — the prior bash regex matched any `Grappa.X` line in
    `lib/grappa/hot_reload/long_lived_modules.ex` regardless of whether
    the match came from the `@modules` / `@state_helpers` SoT
    attributes or from a typespec union. Adding a module to the union
    without updating `@modules` silently passed preflight (CP28 incident
    class).

  * **H20** — the prior bash regex missed several path classes whose
    edits MUST trigger COLD: `compose.override.yaml`,
    `compose.oneshot.yaml`, `bin/grappa`, `.dockerignore`, deeper
    `infra/snippets/*` paths, ALL `config/*.exs`, AND
    `priv/repo/migrations/*` (the migration-gap was repro'd live during
    the REV-B deploy).

  All preflight rules live HERE so the shell dispatcher is a thin
  invoker that does not own classification logic. See `cli/1` for the
  shell-facing entry point.

  ## Substrate-scoped classes

  Classification is per-substrate (`:docker` for the dev/CI compose
  stack via `scripts/deploy.sh`, `:jail` for the m42 bastille jail via
  `infra/freebsd/deploy.sh`, `:linux` for a native systemd host via
  `infra/linux/deploy.sh`). Most classes are substrate-independent
  (deps, supervision tree, migrations, config, state-shape),
  but the boot-substrate files are not: a `Dockerfile` diff is COLD
  on Docker and irrelevant to the jail or a systemd host,
  `infra/freebsd/rc.d/grappa` is COLD on the jail and irrelevant
  elsewhere, `infra/linux/systemd/grappa.service` is COLD on
  `:linux` and irrelevant elsewhere, and the whole nginx class —
  `infra/linux/nginx.conf` plus the shared `infra/snippets/*` proxy
  surface — is HOT on `:jail`, which since the jail-nginx removal
  runs no proxy of its own at all (#923 scoping, widened). The repo-root
  `VERSION` file spans TWO substrates rather than one: it is COLD on
  `:jail` and `:linux`, which boot a `mix release` whose lib directory
  carries the vsn in its path, and HOT on `:docker`, which does not —
  see `version?/1`. The 2026-06-10 metadata-strip
  deploy cold-restarted prod (ALL IRC sessions dropped) for a
  Dockerfile diff the jail never reads — on an always-on bouncer
  every needless restart is incident-grade, so the substrate is an
  explicit required argument, never a default.

  ## Conservative bias

  In doubt, COLD. A false-COLD costs ~30s of restart downtime; a
  false-HOT silently corrupts the live BEAM (CP28). Per CLAUDE.md
  "Don't add error handling for scenarios that can't happen" the
  classifier returns exactly `{:hot, []}` or `{:cold, [reason()]}` —
  no `:unknown` middle state. An unknown substrate is NOT classified
  conservatively — it's a usage error and crashes loudly (a silent
  guess would hide a miswired call site forever).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.HotReload.LongLivedModules]

  alias Grappa.HotReload.LongLivedModules

  @type substrate :: :docker | :jail | :linux

  @type reason ::
          {:mix_deps, [String.t()]}
          | {:application, [String.t()]}
          | {:image_substrate, [String.t()]}
          | {:rc_d, [String.t()]}
          | {:systemd_unit, [String.t()]}
          | {:migration, [String.t()]}
          | {:nginx, [String.t()]}
          | {:config, [String.t()]}
          | {:version, [String.t()]}
          | {:state_shape, [String.t()]}

  @type verdict :: {:hot, []} | {:cold, [reason()]}

  @typedoc """
  Expand-vs-contract class of ONE migration's up-direction body.

  `:hot` means every DDL op is provably **expand**: the currently-loaded
  (old) code cannot reference what the op adds, so applying it while old
  code still runs has a ZERO crash window. `:cold` means contract, or
  "cannot prove expand" — the two are deliberately the same verdict.
  """
  @type migration_class :: :hot | :cold

  @substrates [:docker, :jail, :linux]
  # The substrates that boot from a `mix release` artifact, whose lib
  # directory carries the OTP application vsn in its PATH. Docker is
  # absent by construction, not by omission — see `version?/1`.
  @release_substrates [:jail, :linux]
  # CLI-boundary mirror of @substrates — derived, not hand-kept, so a
  # third substrate can't be accepted by classify_paths/2 yet rejected
  # at the cli/1 guard (or vice versa).
  @substrate_strings Enum.map(@substrates, &Atom.to_string/1)

  @doc """
  Classify a list of changed paths for the given deploy substrate,
  WITHOUT any file content. Content-blind, so every touched migration
  counts as COLD — see `classify_paths/3` for the expand/contract
  refinement and `classify/5` for the git-backed caller that supplies it.

  Also does NOT exercise per-file content diffs for long-lived-module
  state-shape checks — again `classify/5`.

  Returns `{:hot, []}` when no path triggers a cold class; otherwise
  `{:cold, [reasons]}` enumerating every triggered class. Raises
  `FunctionClauseError` on an unknown substrate — loud usage error,
  never a silent guess.
  """
  @spec classify_paths([String.t()], substrate()) :: verdict()
  def classify_paths(paths, substrate), do: classify_paths(paths, substrate, fn _ -> nil end)

  @doc """
  `classify_paths/2` plus the migration expand/contract refinement.

  `migration_source_fn.(path)` returns the migration's source at the
  TARGET rev (`nil` when it cannot be read — deleted file, unknown rev).
  An unreadable migration classifies COLD, which is exactly why
  `classify_paths/2` (whose source fn always returns `nil`) is the
  conservative content-blind shape rather than a special case.
  """
  @spec classify_paths([String.t()], substrate(), (String.t() -> String.t() | nil)) :: verdict()
  def classify_paths(paths, substrate, migration_source_fn)
      when is_list(paths) and substrate in @substrates and
             is_function(migration_source_fn, 1) do
    reasons =
      []
      |> add_reason(:mix_deps, Enum.filter(paths, &mix_deps?/1))
      |> add_reason(:application, Enum.filter(paths, &application?/1))
      |> add_reason(:image_substrate, filter_on([:docker], substrate, paths, &docker_image?/1))
      |> add_reason(:rc_d, filter_on([:jail], substrate, paths, &rc_d?/1))
      |> add_reason(:systemd_unit, filter_on([:linux], substrate, paths, &systemd_unit?/1))
      |> add_reason(:migration, contract_migrations(paths, migration_source_fn))
      |> add_reason(:nginx, filter_on([:linux], substrate, paths, &nginx?/1))
      |> add_reason(:config, Enum.filter(paths, &config?/1))
      |> add_reason(:version, filter_on(@release_substrates, substrate, paths, &version?/1))
      |> Enum.reverse()

    case reasons do
      [] -> {:hot, []}
      _ -> {:cold, reasons}
    end
  end

  @doc """
  Classify ONE migration's source as `:hot` (expand) or `:cold`.

  Pure AST inference over the `change/0` / `up/0` body — **no
  annotation, no opt-in flag**. A migration cannot vouch for itself:
  the 2026-08-05 `add_old_nick_to_session_log_events` moduledoc
  declares "HOT" in prose while the classifier of the day cold-tripped
  it, and prose is not a gate.

  ## The asymmetry this encodes

  An **expand** op has a ZERO crash window: old code never references
  the column/table/index being added, new code finds it present. A
  **contract** op has no safe ordering at all — the BEAM and sqlite do
  not share a clock, so a commit cannot be made atomic with the
  per-process code switch (a GenServer adopts reloaded code on its NEXT
  message). Holding the DDL transaction open until every process has
  switched does not help either: sqlite is single-writer, so the live
  `Session.Server`s persisting scrollback would starve into
  `busy_timeout` — a schema crash traded for a write-timeout crash.

  So the cost of the two errors is NOT symmetric. A false-COLD costs
  one restart. A false-HOT crashes a `Session.Server`, which is linked
  to its `IRC.Client`, which owns the upstream socket — a visible QUIT
  on the network. **Hence an ALLOWLIST: `:hot` only when EVERY op is
  provably expand; `:cold` for contract AND for anything unrecognised.**

  ## HOT (allowlisted)

    * `create table(...)` / `create_if_not_exists table(...)`, with or
      without a block — a table nothing has ever written to, and the
      block's contents are irrelevant for the same reason.
    * `create index(...)` without a `unique:` option (a plain index
      changes no write's validity).
    * `create unique_index(...)` / `create constraint(...)` **on a table
      the same body created** with a plain `create table` — widened
      past the #41 text, which had not weighed how common the shape is:
      8 of the 14 create-table migrations in this repo pair the two, so
      without it "new feature table" stays COLD forever. The proof is
      structural, not statistical — `create table` raises if the table
      exists, so reaching the index statement means zero rows and no
      loaded schema. `create_if_not_exists table(...)` is deliberately
      NOT enough: it may have found a populated table.
    * inside `alter table(...)`: `add` / `add_if_not_exists` of a
      literal column name with a literal type, when the column is
      nullable (`null: true`, or `null` absent — Ecto's default) or
      carries a `default:`. Both shapes keep an old-code INSERT that
      omits the column valid.

  ## COLD (everything else), notably

    * `remove` / `remove_if_exists` / `rename` / `modify` / `drop` /
      `drop_if_exists` — contract by definition.
    * `add ..., null: false` with no `default:` — old-code INSERTs that
      omit the column start failing the moment the DDL commits.
    * `create unique_index(...)` / `create constraint(...)` on a
      PRE-EXISTING table — an old write that was legal before can start
      failing (and a duplicate already in the table fails the DDL).
    * `execute(raw_sql)` — opaque. Teaching the classifier to read raw
      SQL would be exactly the false-HOT this design exists to prevent.
    * `references(...)` or any non-literal type/column/option; local
      helper calls; `flush/0`; conditionals; anything unparseable.
    * `@disable_ddl_transaction` — the fail-aborts-reload contract in
      `Grappa.HotReload.migrate_and_reload/0` rests on the migration
      rolling back. A migration that opts out of the transaction cannot
      make that promise.
    * a module with no `change/0` and no `up/0` — including `def change,
      do: :ok`, whose body is a literal rather than an op. Provably
      harmless, deliberately still COLD: the allowlist enumerates OPS,
      and "harmless non-op" is a second, unrelated proof obligation.
  """
  @spec classify_migration(String.t()) :: migration_class()
  def classify_migration(source) when is_binary(source) do
    case Code.string_to_quoted(source) do
      {:ok, ast} -> classify_migration_ast(ast)
      {:error, _} -> :cold
    end
  end

  @doc """
  Returns the list of source-file paths corresponding to
  `LongLivedModules.all/0`. Single-sourced from the SoT module — no
  string parsing, no regex.

  Used by `classify/5` to know which touched files need a state-shape
  diff (Class 3).
  """
  @spec long_lived_module_files() :: [String.t()]
  def long_lived_module_files do
    Enum.map(LongLivedModules.all(), &module_to_path/1)
  end

  @doc """
  `Grappa.Foo.Bar` → `lib/grappa/foo/bar.ex`, `GrappaWeb.Foo` →
  `lib/grappa_web/foo.ex`. `Macro.underscore/1` handles CamelCase →
  snake_case and dot-to-slash.

  The mapping is a naming CONVENTION, not a lookup: a module whose file
  does not sit where its name says loses its state-shape check silently,
  because a path that exists at neither rev compares equal and classifies
  HOT. `Grappa.HotReload.LongLivedModulesMembershipTest` holds every
  candidate module to it.
  """
  @spec module_to_path(module()) :: String.t()
  def module_to_path(mod) when is_atom(mod) do
    "lib/" <>
      (mod
       |> Atom.to_string()
       |> String.replace_prefix("Elixir.", "")
       |> Macro.underscore()) <> ".ex"
  end

  @doc """
  Compare two revisions of the same source file's `@type t :: %{...}`
  and `defstruct` blocks. Returns `:cold` if the blocks differ
  (field-additions or removals), `:hot` if equivalent (including
  cosmetic reformatting).

  Both `from_source` and `to_source` are full Elixir source strings.
  """
  @spec classify_state_shape(String.t(), String.t()) :: :hot | :cold
  def classify_state_shape(from_source, to_source)
      when is_binary(from_source) and is_binary(to_source) do
    if extract_state_block(from_source) == extract_state_block(to_source) do
      :hot
    else
      :cold
    end
  end

  @doc """
  Extract the `@type t :: %{...}` and `defstruct ...` blocks from an
  Elixir source string. Whitespace is normalized to single spaces so
  cosmetic reformatting does not surface as a diff.

  Implemented via the Elixir tokenizer (`Code.string_to_quoted/2`) —
  REPLACES `scripts/_extract_state_block.awk` which used hand-rolled
  brace-counting (per review C4: "regex can't match balanced
  delimiters — and HIGH-27's whole point is that regex is exactly the
  bug class"). The compiler's tokenizer IS the authority on Elixir
  syntax — no parser regression risk.

  Returns the empty string when no state block is present. Returns a
  unique parse-failure marker when the source does not parse, so two
  unparseable sources NEVER compare equal — conservative bias keeps
  parse failures classified as COLD per "in doubt, COLD" (REV-C
  reviewer LOW-3).
  """
  @spec extract_state_block(String.t()) :: String.t()
  def extract_state_block(source) when is_binary(source) do
    case Code.string_to_quoted(source) do
      {:ok, ast} ->
        ast
        |> collect_state_blocks()
        |> Enum.map_join(" ", &normalize/1)

      {:error, _} ->
        # Conservative bias per "in doubt, COLD" — embed a hash of
        # the unparseable source so two different parse-failures
        # don't accidentally compare equal. `:erlang.phash2/1` is
        # process-local-stable; no crypto needed here, we just want
        # inequality across distinct sources.
        "##unparseable##" <> Integer.to_string(:erlang.phash2(source))
    end
  end

  @doc """
  CLI entry point invoked by the deploy orchestrators
  (`scripts/deploy.sh` passes `"docker"`, `infra/freebsd/deploy.sh`
  passes `"jail"`, `infra/linux/deploy.sh` passes `"linux"`).

  Expects exactly three args: `from_sha`, `to_sha`, and the substrate
  string. A missing or unknown substrate is a usage error (exit 2) —
  classifying with a guessed substrate would silently re-introduce
  the cross-substrate cold-restart class this argument exists to
  kill. Shells out to `git diff --name-only` for the changed-paths
  list and to `git show <rev>:<path>` for state-shape checks on
  long-lived modules.

  Prints a human-readable verdict to stdout, then halts the BEAM with
  `exit_code/1` — 0 (HOT) or 3 (COLD). Shell callers case on the exit
  code: 0 → hot, 3 → cold, anything else aborts the deploy. COLD is
  deliberately NOT exit 1: a mix oneshot that crashes (missing env,
  compile error, epmd trouble) exits 1, and a crash must never be
  readable as a verdict — that's how the jail's env-less preflight
  silently classified every deploy COLD (found live 2026-06-10).
  """
  @spec cli([String.t()]) :: no_return()
  def cli([from, to, substrate])
      when is_binary(from) and is_binary(to) and substrate in @substrate_strings do
    substrate = String.to_existing_atom(substrate)
    verdict = classify(from, to, substrate, &git_diff_paths/2, &git_show/2)

    case verdict do
      {:hot, []} ->
        IO.puts("  → no unsafe markers → HOT")

      {:cold, reasons} ->
        IO.puts("Cold-deploy required:")

        Enum.each(reasons, fn {kind, files} ->
          IO.puts("  → #{kind}: #{Enum.join(files, ", ")}")
        end)
    end

    System.halt(exit_code(verdict))
  end

  def cli(_) do
    IO.puts(
      :stderr,
      "usage: mix run -e 'Grappa.Deploy.Preflight.cli([from_sha, to_sha, \"docker\" | \"jail\" | \"linux\"])'"
    )

    System.halt(2)
  end

  @doc """
  Verdict → CLI exit code: HOT 0, COLD 3. See `cli/1` for why COLD
  is not 1 (crash/verdict ambiguity).
  """
  @spec exit_code(verdict()) :: 0 | 3
  def exit_code({:hot, []}), do: 0
  def exit_code({:cold, [_ | _]}), do: 3

  @doc """
  Classify a git diff range for the given deploy substrate. Uses
  injected callbacks for git shell-out (so the module is testable
  without git).

  * `diff_paths_fn.(from, to)` → `[String.t()]` — list of changed paths
    (mirror of `git diff --name-only from..to`).
  * `show_fn.(rev, path)` → `String.t() | nil` — full contents of `path`
    at `rev` (mirror of `git show rev:path`). Returns `nil` when the
    path does not exist at that rev (added/deleted file).
  """
  @spec classify(
          String.t(),
          String.t(),
          substrate(),
          (String.t(), String.t() -> [String.t()]),
          (String.t(), String.t() -> String.t() | nil)
        ) :: verdict()
  def classify(from, to, substrate, diff_paths_fn, show_fn) do
    paths = diff_paths_fn.(from, to)

    case classify_paths(paths, substrate, &show_fn.(to, &1)) do
      {:cold, _} = cold ->
        cold

      {:hot, []} ->
        # Path-class check came up clean. Check state-shape on every
        # touched long-lived module file.
        long_lived_set = MapSet.new(long_lived_module_files())

        touched_long_lived =
          Enum.filter(paths, &MapSet.member?(long_lived_set, &1))

        state_shape_changes =
          for path <- touched_long_lived,
              shape = compare_state_shape(path, from, to, show_fn),
              shape == :cold do
            path
          end

        case state_shape_changes do
          [] -> {:hot, []}
          files -> {:cold, [{:state_shape, files}]}
        end
    end
  end

  # ---- internals ----------------------------------------------------
  defp add_reason(reasons, _, []), do: reasons
  defp add_reason(reasons, kind, files), do: [{kind, files} | reasons]

  # Substrate-scoped filter: the predicate only applies when the diff is
  # being classified FOR a substrate that reads those files. The scope is
  # always a LIST, including at the single-substrate call sites — one
  # shape for one helper, so the next class that spans two substrates
  # has nothing to choose between.
  defp filter_on(scopes, substrate, paths, pred) do
    if substrate in scopes, do: Enum.filter(paths, pred), else: []
  end

  # Class 1: dep / build config.
  defp mix_deps?(path), do: path in ["mix.lock", "mix.exs"]

  # Class 2: supervision tree (Application.start/2 is boot-only).
  defp application?(path), do: path == "lib/grappa/application.ex"

  # Class 4a: Docker image substrate — applies ONLY when classifying
  # for :docker (see filter_on/4); the jail never reads these files
  # (the 2026-06-10 incident — full story in the moduledoc).
  #
  # Deploy ORCHESTRATORS — `scripts/deploy.sh` (Docker) and
  # `infra/freebsd/deploy.sh` (jail) — are intentionally NOT in this
  # list. They're shell scripts the operator invokes; nothing about
  # them lands in the running BEAM, the rc.d daemon, or the next
  # container spawn. COLD-restarting the live BEAM to "pick up" a
  # deploy.sh edit was 30s of pointless downtime — the new bytes are
  # on disk for the NEXT deploy regardless of how this one classifies.
  # See d8f354c + 55f0415 (2026-05-31) — two consecutive prod
  # incidents triggered by a deploy.sh edit forcing COLD + the COLD
  # path racing on the epmd "name in use" trap. Fixed both layers:
  # this rule + the wait-loop + the re-exec guard.
  defp docker_image?("Dockerfile"), do: true
  defp docker_image?(".dockerignore"), do: true
  defp docker_image?("bin/start.sh"), do: true
  defp docker_image?("bin/grappa"), do: true
  # compose.* is a PREFIX class, not an enumeration — H20 already
  # proved the enumeration failure mode twice (compose.override.yaml
  # and compose.oneshot.yaml were both missed by the prior allowlist).
  # Diff paths are repo-relative, so the prefix only matches files at
  # the repo root; a false-COLD on a hypothetical non-compose
  # `compose.*` file is the cheap direction (Conservative bias).
  defp docker_image?(path), do: String.starts_with?(path, "compose.")

  # Class 4b: jail rc.d wrapper — applies ONLY when classifying for
  # :jail, and ONLY the grappa wrapper: this class means "the grappa
  # service must restart to pick the file up". `infra/freebsd/rc.d/`
  # holds exactly one service since #923 deleted the retired
  # grappa_ndp_keepalive (#628), so the literal match and the
  # directory now describe the same thing — a SECOND rc(8) service
  # arriving here would need its own decision, not this clause.
  defp rc_d?("infra/freebsd/rc.d/grappa"), do: true
  defp rc_d?(_), do: false

  # Class 4c: Linux systemd unit — applies ONLY when classifying for
  # :linux. Sibling of rc_d?/1 (4b) and docker_image?/1 (4a): a changed
  # unit file needs `systemctl daemon-reload` + a restart to take
  # effect (there is no hot-reload of a running unit's own
  # definition), and neither Docker nor the jail read this file at
  # all, so the rule must stay :linux-scoped via filter_on/4 the same
  # way rc_d? is :jail-scoped.
  defp systemd_unit?("infra/linux/systemd/grappa.service"), do: true
  defp systemd_unit?(_), do: false

  # Class 5: migrations — CONTRACT ones only (GH #41). The class used
  # to be the path prefix alone, because the hot path ran no migration
  # at all and a new table/column 500'd on the first query post-reload
  # (REV-B repro'd this). `GrappaWeb.AdminController.reload/2` now runs
  # `Ecto.Migrator` in-process before the module reload, so an
  # all-expand migration no longer needs the restart — only a contract
  # one does, and for a reason no ordering can fix (see
  # `classify_migration/1`).
  defp contract_migrations(paths, source_fn) do
    Enum.filter(paths, fn path ->
      migration?(path) and migration_class(source_fn.(path)) == :cold
    end)
  end

  defp migration?(path), do: String.starts_with?(path, "priv/repo/migrations/")

  # An unreadable migration is indistinguishable from an unclassifiable
  # one, and gets the same conservative verdict.
  defp migration_class(nil), do: :cold
  defp migration_class(source) when is_binary(source), do: classify_migration(source)

  defp classify_migration_ast(ast) do
    bodies = up_direction_bodies(ast)

    if bodies != [] and not disable_ddl_transaction?(ast) and
         Enum.all?(bodies, &hot_body?/1) do
      :hot
    else
      :cold
    end
  end

  # The bodies that run on `Ecto.Migrator.run(_, :up, _)`: `change/0`
  # (run forward) and `up/0`. `down/0` is deliberately ignored — it
  # never executes on the deploy path, so a contract `down` must not
  # cold-trip an expand `up`.
  defp up_direction_bodies(ast) do
    {_, acc} =
      Macro.prewalk(ast, [], fn
        {:def, _, [{name, _, args}, [do: body]]} = node, acc
        when name in [:change, :up] and (is_nil(args) or args == []) ->
          {node, [body | acc]}

        node, acc ->
          {node, acc}
      end)

    acc
  end

  defp disable_ddl_transaction?(ast) do
    {_, found} =
      Macro.prewalk(ast, false, fn
        {:@, _, [{:disable_ddl_transaction, _, _}]} = node, _ -> {node, true}
        node, acc -> {node, acc}
      end)

    found
  end

  defp hot_body?(body) do
    stmts = statements(body)
    fresh = fresh_tables(stmts)
    Enum.all?(stmts, &hot_op?(&1, fresh))
  end

  defp statements({:__block__, _, stmts}), do: stmts
  defp statements(single), do: [single]

  # Tables this body BRINGS INTO EXISTENCE. `create table` fails if the
  # table is already there, so reaching the next statement proves the
  # table is empty and that no loaded code has a schema for it.
  # `create_if_not_exists` proves nothing of the sort and is excluded.
  defp fresh_tables(stmts) do
    for {:create, _, [{:table, _, [name | _]} | _]} <- stmts,
        is_atom(name),
        into: MapSet.new(),
        do: name
  end

  # `create index(...)` — no block.
  defp hot_op?({create, _, [subject]}, fresh) when create in [:create, :create_if_not_exists],
    do: creatable?(subject, fresh)

  # `create table(...) do ... end` — the block's ops are unconditionally
  # safe: nothing has ever written to a table this migration creates.
  defp hot_op?({create, _, [subject, [do: _]]}, _)
       when create in [:create, :create_if_not_exists],
       do: table?(subject)

  defp hot_op?({:alter, _, [{:table, _, _}, [do: block]]}, _),
    do: Enum.all?(statements(block), &hot_alter_op?/1)

  defp hot_op?(_, _), do: false

  defp creatable?({:table, _, _}, _), do: true
  defp creatable?({:index, _, args}, _), do: plain_index?(args)

  # A uniqueness rule can turn a write that was legal a moment ago into
  # a failure — UNLESS the table was created by this same body, where
  # there is neither a pre-existing row to violate it nor loaded code
  # that knows the table at all. Structural proof from the AST, not an
  # inference about what the data looks like.
  #
  # THE BOUNDARY IS THE FRESH TABLE, and it does not move. On a
  # PRE-EXISTING table this is a different animal in two ways at once:
  # the DDL itself can fail on duplicate rows already stored, and an
  # old-code write that was legal a moment ago starts failing. Neither
  # is provable from the AST, so both stay COLD. Do not relax this to
  # "any unique_index" — that is the false-HOT the allowlist exists for.
  defp creatable?({guarded, _, [table | _]}, fresh) when guarded in [:unique_index, :constraint],
    do: is_atom(table) and MapSet.member?(fresh, table)

  defp creatable?(_, _), do: false

  defp table?({:table, _, _}), do: true
  defp table?(_), do: false

  # `unique_index/2,3` is a DIFFERENT DSL call and never reaches here;
  # this only has to reject `index(..., unique: true)`. Any other option
  # (`where:`, `name:`, ...) still describes a plain index, which cannot
  # invalidate a write that was legal a moment ago.
  defp plain_index?([_, _]), do: true

  defp plain_index?([_, _, opts]) when is_list(opts),
    do: not Keyword.has_key?(opts, :unique)

  defp plain_index?(_), do: false

  defp hot_alter_op?({add, _, [column, type]}) when add in [:add, :add_if_not_exists],
    do: is_atom(column) and literal_type?(type)

  defp hot_alter_op?({add, _, [column, type, opts]}) when add in [:add, :add_if_not_exists],
    do: is_atom(column) and literal_type?(type) and old_inserts_still_valid?(opts)

  defp hot_alter_op?(_), do: false

  # A quoted `references(...)` / `fragment(...)` / bare variable is a
  # 3-tuple, never a literal — so this rejects them by construction.
  defp literal_type?(type) when is_atom(type), do: true
  defp literal_type?({:array, inner}) when is_atom(inner), do: true
  defp literal_type?(_), do: false

  # An old-code INSERT omits the new column entirely, so it stays valid
  # iff the column is nullable or the DDL supplies a default. A
  # non-literal `null:` value cannot be proven either way → COLD.
  defp old_inserts_still_valid?(opts) when is_list(opts) do
    case Keyword.fetch(opts, :null) do
      :error -> true
      {:ok, true} -> true
      {:ok, false} -> Keyword.has_key?(opts, :default)
      {:ok, _} -> false
    end
  end

  defp old_inserts_still_valid?(_), do: false

  # Class 6: nginx config + ALL infra/snippets (H20 deeper-paths gap —
  # prior regex was `^infra/(nginx\.conf|snippets/)` which only matched
  # files DIRECTLY under snippets/, not nested ones).
  #
  # **`:linux` is the only substrate left that runs nginx**, so the whole
  # class is scoped to it via `filter_on/4`, exactly like its siblings
  # `rc_d?/1` (:jail), `systemd_unit?/1` (:linux) and `docker_image?/1`
  # (:docker). It used to be scoped inline by a 2-arity predicate because
  # the class was MIXED — two per-substrate configs plus a genuinely
  # shared snippet prefix. It is not mixed any more: #485 dropped the
  # Docker nginx container (the BEAM is published directly), and the
  # bastille jail's nginx was deleted outright once #485 had hollowed it
  # into a pure pass-through — the m42 HOST vhost proxies straight to the
  # jail BEAM on :4000. Neither substrate reads `infra/snippets/*` any
  # more, and charging a session-dropping COLD on m42 prod for a file
  # nothing there opens is exactly the #923 failure this scoping exists
  # to prevent (and before that, the 2026-06-10 Dockerfile diff that
  # cold-restarted the jail — see the moduledoc).
  #
  # The e2e proxy (`cicchetto/e2e/nginx-test.conf`) and the AWS box
  # (`infra/cloud/first-boot.sh`, which FETCHES the snippet) also include
  # it, which is why the snippet itself stays — but neither is a deploy
  # substrate this classifier is ever called with.
  #
  # COLD means the BEAM must not be hot-swapped past this change; the
  # nginx bytes themselves are refreshed by the substrate's own install
  # script, not by the restart.
  defp nginx?("infra/linux/nginx.conf"), do: true
  defp nginx?(path), do: String.starts_with?(path, "infra/snippets/")

  # Class 7 (H20+H21): ALL config/*.exs. SECRET_SIGNING_SALT was
  # silently HOT'd before this rule because config/config.exs didn't
  # match any prior regex. Per S3 advice: "any config/*.exs change →
  # COLD. False-positive cost is small; false-negative cost is
  # SECRET_SIGNING_SALT rotation that doesn't take effect."
  defp config?(path) do
    String.starts_with?(path, "config/") and String.ends_with?(path, ".exs")
  end

  # Class 8 (#1287): the repo-root VERSION file — the SSOT for the OTP
  # application vsn, which `mix.exs` reads at build time. COLD on the
  # substrates that boot a `mix release`, and ONLY those.
  #
  # The bump does not merely change a string: it moves every artifact to
  # `lib/grappa-<new>/ebin`, while the running node keeps resolving
  # `:code.lib_dir(:grappa)` — the directory `HotReload.reload_modified/0`
  # walks, and the root `Ecto.Migrator` reaches through
  # `Application.app_dir/1,2` — to the BOOT directory `lib/grappa-<old>/ebin`.
  # The new artifacts land in a SIBLING the node never looks at, so the
  # reload diffs the stale tree against itself and answers
  # `{"failed":[],"reloaded":[],"migrated":[]}`. That is indistinguishable
  # from "nothing to do": the miss cannot be reported, only prevented here.
  # Repro'd in production 2026-08-13 on a self-hosted `:linux` install
  # deploying v1.0.0 → v1.1.0 — ~6.5 hours serving the old BEAM under the
  # new git history. Before #652 the number lived in `mix.exs` and
  # `mix_deps?/1` caught the bump by accident; moving it to VERSION removed
  # the accident without replacing the rule.
  #
  # Docker is excluded by MEASUREMENT, not by omission: the container execs
  # `mix phx.server` over a bind-mounted tree (`bin/start.sh:76`), where
  # `:code.lib_dir(:grappa)` is `/app/_build/<env>/lib/grappa` — no vsn in
  # the path, so the fresh beams land where the node is already looking.
  # The two release substrates say the opposite in their own words:
  # `infra/freebsd/deploy.sh:116` names `lib/grappa-X.Y/ebin` as the
  # daemon's code path. COLDing docker for a file its boot layout is immune
  # to would be the needless-restart class the substrate argument exists to
  # prevent (moduledoc: 2026-06-10, #923) — on an always-on bouncer every
  # restart drops every IRC session.
  #
  # Exact repo-root match: a sibling `VERSION` elsewhere in the tree (e.g.
  # `cicchetto/VERSION`) is a different file with no bearing on the OTP vsn.
  defp version?("VERSION"), do: true
  defp version?(_), do: false

  # Walk the AST collecting nodes that match any of:
  #   * `@type t :: %{...}`     — bare-map state typespec
  #   * `defstruct ...`         — struct state shape
  #   * `init/1` `{:ok, %{...}}` map literal — the state a GenServer
  #     that carries its shape as a bare init map (no @type/defstruct)
  #     boots with. `deploy.sh:20-23` promises this third shape is
  #     detected; without this clause a field-add to such a map
  #     classifies HOT and the next callback pattern-matches the new
  #     shape against OLD in-memory state (silent-corruption class).
  # Returns a list of quoted forms (one per match) so the caller can
  # render to a comparable string.
  defp collect_state_blocks(ast) do
    {_, acc} =
      Macro.prewalk(ast, [], fn
        # `@type t :: ...`
        {:@, _, [{:type, _, [{:"::", _, [{:t, _, _} | _]}]}]} = node, acc ->
          {node, [node | acc]}

        # `defstruct ...`
        {:defstruct, _, _} = node, acc ->
          {node, [node | acc]}

        # `def init(_) do ... end` / `defp init(_) do ... end` (a
        # guarded head `init(_) when ...` too) — collect the map
        # literal(s) it returns as state. Scoped to init/1 so a
        # same-shaped `{:ok, %{...}}` in an unrelated helper (e.g. an
        # RPL_LIST parser) is NOT mistaken for state shape.
        {def_kw, _, [head, _]} = node, acc when def_kw in [:def, :defp] ->
          if init_head?(head), do: {node, init_return_maps(node) ++ acc}, else: {node, acc}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(acc)
  end

  # True when a `def`/`defp` head is the `init/1` callback, unwrapping an
  # optional `when` guard (`def init(x) when is_map(x)` quotes the head
  # as `{:when, _, [{:init, _, [_]}, guard]}`).
  defp init_head?({:when, _, [inner | _]}), do: init_head?(inner)
  defp init_head?({:init, _, [_]}), do: true
  defp init_head?(_), do: false

  # Collect the map literal(s) an `init/1` clause returns as its
  # GenServer state: every `{:ok, %{...}}` (2-tuple) and
  # `{:ok, %{...}, _}` (n-tuple, e.g. `{:continue, _}`) in the init
  # body — case/with branches included, so a multi-branch init that
  # returns different state shapes contributes all of them. A struct
  # return (`{:ok, %__MODULE__{}}`) is deliberately skipped: its second
  # element is a `%Struct{}` node, not a bare `%{}`, so its shape is
  # already tracked via the module's `defstruct`.
  defp init_return_maps(init_node) do
    {_, maps} =
      Macro.prewalk(init_node, [], fn
        # `{:ok, %{...}}` — 2-tuples are literal tuples in the AST.
        {:ok, {:%{}, _, _} = map} = node, acc ->
          {node, [map | acc]}

        # `{:ok, %{...}, _}` — 3+-tuples quote as `{:{}, _, [...]}`.
        {:{}, _, [:ok, {:%{}, _, _} = map | _]} = node, acc ->
          {node, [map | acc]}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(maps)
  end

  # Normalize a quoted form to a whitespace-collapsed string. Two
  # cosmetically-different sources of the same block compare equal.
  defp normalize(quoted) do
    quoted
    |> Macro.to_string()
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end

  # Compare a single long-lived-module file's state-shape between two
  # revs. Returns `:hot` if the @type t/defstruct blocks are equivalent
  # (or the path doesn't exist on either side), `:cold` otherwise.
  defp compare_state_shape(path, from, to, show_fn) do
    from_src = show_fn.(from, path) || ""
    to_src = show_fn.(to, path) || ""
    classify_state_shape(from_src, to_src)
  end

  # Bash-side equivalent: `git diff --name-only from..to`. The `env:
  # []` opt clears subprocess env: git needs none of the BEAM
  # process's secrets to walk objects (Credo
  # `Credo.Check.Warning.Cmd`).
  defp git_diff_paths(from, to) do
    {output, 0} =
      System.cmd("git", ["diff", "--name-only", "#{from}..#{to}"], env: [])

    String.split(output, "\n", trim: true)
  end

  # Bash-side equivalent: `git show rev:path` (returns nil if path does
  # not exist at that rev — added or deleted file). `env: []` per same
  # rationale as `git_diff_paths/2` above.
  defp git_show(rev, path) do
    case System.cmd("git", ["show", "#{rev}:#{path}"],
           stderr_to_stdout: true,
           env: []
         ) do
      {output, 0} -> output
      {_, _} -> nil
    end
  end
end
