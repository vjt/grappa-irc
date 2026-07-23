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
  (deps, supervision tree, migrations, nginx, config, state-shape),
  but the boot-substrate files are not: a `Dockerfile` diff is COLD
  on Docker and irrelevant to the jail or a systemd host,
  `infra/freebsd/rc.d/grappa` is COLD on the jail and irrelevant
  elsewhere, and `infra/linux/systemd/grappa.service` is COLD on
  `:linux` and irrelevant elsewhere. The 2026-06-10 metadata-strip
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
          | {:state_shape, [String.t()]}

  @type verdict :: {:hot, []} | {:cold, [reason()]}

  @substrates [:docker, :jail, :linux]
  # CLI-boundary mirror of @substrates — derived, not hand-kept, so a
  # third substrate can't be accepted by classify_paths/2 yet rejected
  # at the cli/1 guard (or vice versa).
  @substrate_strings Enum.map(@substrates, &Atom.to_string/1)

  @doc """
  Classify a list of changed paths for the given deploy substrate.
  Does NOT exercise per-file content diffs for long-lived-module
  state-shape checks — use `classify/5` with the from/to revs for that.

  Returns `{:hot, []}` when no path triggers a cold class; otherwise
  `{:cold, [reasons]}` enumerating every triggered class. Raises
  `FunctionClauseError` on an unknown substrate — loud usage error,
  never a silent guess.
  """
  @spec classify_paths([String.t()], substrate()) :: verdict()
  def classify_paths(paths, substrate)
      when is_list(paths) and substrate in @substrates do
    reasons =
      []
      |> add_reason(:mix_deps, Enum.filter(paths, &mix_deps?/1))
      |> add_reason(:application, Enum.filter(paths, &application?/1))
      |> add_reason(:image_substrate, filter_on(:docker, substrate, paths, &docker_image?/1))
      |> add_reason(:rc_d, filter_on(:jail, substrate, paths, &rc_d?/1))
      |> add_reason(:systemd_unit, filter_on(:linux, substrate, paths, &systemd_unit?/1))
      |> add_reason(:migration, Enum.filter(paths, &migration?/1))
      |> add_reason(:nginx, Enum.filter(paths, &nginx?/1))
      |> add_reason(:config, Enum.filter(paths, &config?/1))
      |> Enum.reverse()

    case reasons do
      [] -> {:hot, []}
      _ -> {:cold, reasons}
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

    case classify_paths(paths, substrate) do
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

  # Substrate-scoped filter: the predicate only applies when the diff
  # is being classified FOR the substrate that reads those files.
  # First head matches when scope == substrate.
  defp filter_on(scope, scope, paths, pred), do: Enum.filter(paths, pred)
  defp filter_on(_, _, _, _), do: []

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
  # service must restart to pick the file up". The sibling
  # `infra/freebsd/rc.d/grappa_ndp_keepalive` is deliberately NOT
  # here — it's a different rc(8) service, and cold-restarting the
  # BEAM (dropping every IRC session) would not refresh it anyway.
  # Its bytes are refreshed by jail_install_rcd.sh, which the jail
  # cold path runs before every restart.
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

  # Class 5: migrations. The hot path skips `mix ecto.migrate`; new
  # tables/columns 500 on first query post-reload (REV-B repro'd this).
  defp migration?(path), do: String.starts_with?(path, "priv/repo/migrations/")

  # Class 6: nginx config + ALL infra/snippets (H20 deeper-paths gap —
  # prior regex was `^infra/(nginx\.conf|snippets/)` which only matched
  # files DIRECTLY under snippets/, not nested ones). Plus the bastille
  # jail's parallel `infra/freebsd/nginx.conf` (the jail's internal
  # nginx between the BEAM and the host nginx that fronts public TLS).
  defp nginx?("infra/nginx.conf"), do: true
  defp nginx?("infra/freebsd/nginx.conf"), do: true
  defp nginx?(path), do: String.starts_with?(path, "infra/snippets/")

  # Class 7 (H20+H21): ALL config/*.exs. SECRET_SIGNING_SALT was
  # silently HOT'd before this rule because config/config.exs didn't
  # match any prior regex. Per S3 advice: "any config/*.exs change →
  # COLD. False-positive cost is small; false-negative cost is
  # SECRET_SIGNING_SALT rotation that doesn't take effect."
  defp config?(path) do
    String.starts_with?(path, "config/") and String.ends_with?(path, ".exs")
  end

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

  # `Grappa.Foo.Bar` → `lib/grappa/foo/bar.ex`.
  # Macro.underscore handles CamelCase → snake_case + dot-to-slash.
  defp module_to_path(mod) do
    "lib/grappa/" <>
      (mod
       |> Atom.to_string()
       |> String.replace_prefix("Elixir.Grappa.", "")
       |> Macro.underscore()) <> ".ex"
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
