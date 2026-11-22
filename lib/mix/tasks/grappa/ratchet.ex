defmodule Mix.Tasks.Grappa.Ratchet do
  @shortdoc "Fail when Session.Server's state/clauses or a boundary's deps moved off the record"

  @moduledoc """
  The ratchet from issue 2690 (architecture review 2026-11-21, finding X1).

  `Grappa.Session.Server` keeps absorbing domains, and nothing used to stop
  the next one. Whether it gets a ceiling or a split is issue 2133 and stays
  undecided. This task is the cheap half that holds either way: growth is no
  longer free. It has to be recorded and explained.

  ## What is counted, and how

  Every quantity is read off the BUILD, never off the source text. The review
  that asked for this gate printed two state-key counts, 94 (a regex over the
  `@type t` block) and 96 (reading `Server.t()`); the compiler says 101 at
  `9b66302df`. Where 94 and 96 came from is not known. What is measured is
  that the block itself moved under the review: 95 keys at `cee2b8f0c` and
  `8d90e1242`, 97 at `494b9f2a3`, 101 from the issue 2656 merges
  (`cdf03e167`) on. That is a fact about the tree, not the explanation. A
  count off the build does not depend on which tree a reader had or how they
  counted it.

    * `state_keys:Grappa.Session.Server`: the fields of the `@type t` map,
      from the compiled typespec (`Code.Typespec.fetch_types/1`). A `t` that
      is not a map literal RAISES, so it cannot quietly count as zero.
    * `handle_call_clauses:…` / `handle_info_clauses:…`: the clauses the
      compiler kept for `handle_call/3` and `handle_info/2`, from the beam's
      `debug_info` definitions. The overridden `use GenServer` default is not
      among them, and the known-answer fixture pins that. They are two keys,
      not one sum, so a clause moved from one callback to the other reads as
      a rise on one of them. That is accepted as the price of seeing which
      callback grew.
    * `deps:<Boundary>` for EVERY boundary whose `use Boundary` sits under
      `lib/`: the length of its `deps:` list. It is read from the persisted
      `Boundary` attribute, the same one `Boundary.Definition` reads. The set
      comes from the beams in the compile path, so a new boundary is covered
      the moment it compiles, and a discovery that finds none RAISES. The
      `lib/` filter makes a `MIX_ENV=test` run (which also compiles
      `test/support` boundaries) record the same set as a dev run.

  ## The record

  `priv/ratchet/ratchet.pin` holds one `key = count` line per quantity,
  sorted, so a bump is a one-line diff a review sees. It has its own
  directory, with its own RW mount in `scripts/_lib.sh`, for the reason
  `priv/wire/` has one: `priv/` itself is not mounted from a worktree, and a
  record written straight into it lands in the MAIN checkout.

  `--check` is red on ANY difference:

    * a count above its record: the rise this gate exists for;
    * a count below it: the record must come down too, or the slack hides
      the next rise;
    * a key counted but not recorded, or recorded but no longer counted.

  `--update` always may rewrite the record, because a bump IS the allowed
  path. The second witness is the DESIGN_NOTES line. A commit that raises a
  recorded value must add a line to `docs/DESIGN_NOTES.md` naming the key in
  backticks. That needs git history, so it is checked by
  `scripts/ratchet-gate.sh`, commit by commit, and not here. This task stays
  offline like `mix grappa.wire_pin`: no git, no network, no subprocess.

  ## The known-answer control

  Before any verdict, and before `--update` writes anything, the task
  compiles a fixture module whose answers are known. The fixture has
  3 `@type t` keys (one of them optional), 2 `handle_call/3` clauses, one
  `handle_info/2` clause, the `use GenServer` defaults and 2 boundary deps.
  It runs through the SAME counting functions as the real tree. Then it
  checks the verdict both ways: a record equal to the counts must pass, and
  the same record with one state key fewer must fail as a rise. If any of
  that does not hold, the task prints NO VERDICT and exits 1. It never
  reports agreement from counting it has not just seen work.

  ## Limits, stated so nobody rediscovers them

    * Whether the code agrees with the record is checked at the head that
      is built (the PR head in CI, the local head in `scripts/check.sh`),
      not at every commit. The pairing of a raise with its DESIGN_NOTES line
      IS checked per commit.
    * A renamed boundary reads as one key gone and one new. A key the merge
      base does not carry needs no DESIGN_NOTES line, so a rename passes the
      pairing check.
    * A swap leaves every count unchanged and reads as no change at all: one
      dep replaced by another, a state key renamed or replaced, a clause
      replaced by a different one. The ratchet sees how much, never what.
    * This gate is not a ceiling: any number can be recorded. The ceiling is
      issue 2133's.

  ## Usage

      mix grappa.ratchet --check     # the gate (scripts/check.sh, CI)
      mix grappa.ratchet --update    # rewrite the record from the build

  There is no default mode, for the reason `mix grappa.wire_pin` has none:
  a bare call that rewrote the record would green the gate by accident.
  """

  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @record_path "priv/ratchet/ratchet.pin"

  # The one module whose state and callbacks are counted. Named by its beam
  # file rather than its alias so this task carries no edge into Session.
  @server_beam "Elixir.Grappa.Session.Server.beam"
  @server_name "Grappa.Session.Server"

  @line_re ~r/^(\S+) = (\d+)$/

  @fixture_answers %{state_keys: 3, handle_call_clauses: 2, handle_info_clauses: 1, deps: 2}

  @typedoc "`<quantity>:<module>`, e.g. `deps:Grappa.Session`."
  @type key :: String.t()
  @type counts :: %{key() => non_neg_integer()}

  @typedoc "The fixture's four counts. `deps` is nil when the fixture's boundary was not found."
  @type fixture_counts :: %{
          state_keys: non_neg_integer(),
          handle_call_clauses: non_neg_integer(),
          handle_info_clauses: non_neg_integer(),
          deps: non_neg_integer() | nil
        }

  @type finding ::
          {:rose, key(), non_neg_integer(), non_neg_integer()}
          | {:fell, key(), non_neg_integer(), non_neg_integer()}
          | {:unrecorded, key(), non_neg_integer()}
          | {:gone, key(), non_neg_integer()}

  @impl Mix.Task
  @spec run([String.t()]) :: :ok
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, switches: [check: :boolean, update: :boolean])
    mode = mode(opts)

    Mix.Task.run("loadpaths")
    Mix.Task.run("compile")

    case self_test() do
      :ok -> :ok
      {:error, why} -> abort("NO VERDICT: the ratchet's known-answer control failed.\n\n  #{why}\n")
    end

    counts = counts()

    case mode do
      :check -> do_check(counts)
      :update -> do_update(counts)
    end
  end

  defp mode(opts) do
    case {opts[:check], opts[:update]} do
      {true, _} -> :check
      {_, true} -> :update
      _ -> abort("mix grappa.ratchet needs --check or --update (see `mix help grappa.ratchet`)")
    end
  end

  @doc """
  The verdict, as a pure function of the counts and the record. Lists every
  finding, sorted by key, so one run shows the whole diff.
  """
  @spec check(counts(), counts()) :: :ok | {:error, [finding(), ...]}
  def check(counts, record) do
    findings =
      (Map.keys(counts) ++ Map.keys(record))
      |> Enum.uniq()
      |> Enum.sort()
      |> Enum.flat_map(&finding(&1, Map.fetch(counts, &1), Map.fetch(record, &1)))

    if findings == [], do: :ok, else: {:error, findings}
  end

  defp finding(_, {:ok, n}, {:ok, n}), do: []
  defp finding(key, {:ok, now}, {:ok, rec}) when now > rec, do: [{:rose, key, rec, now}]
  defp finding(key, {:ok, now}, {:ok, rec}), do: [{:fell, key, rec, now}]
  defp finding(key, {:ok, now}, :error), do: [{:unrecorded, key, now}]
  defp finding(key, :error, {:ok, rec}), do: [{:gone, key, rec}]

  @doc "What the developer reads: every finding, then what to do about it."
  @spec failure_message([finding(), ...]) :: String.t()
  def failure_message(findings) do
    lines = Enum.map_join(findings, "\n", &finding_line/1)

    todo =
      if Enum.any?(findings, &match?({:rose, _, _, _}, &1)) do
        """
        A rise is allowed only on purpose. In the same commit:

          1. run `mix grappa.ratchet --update` to rewrite #{@record_path}
          2. add a line to docs/DESIGN_NOTES.md that names each risen key in
             backticks (as printed above) and says why it had to grow

        scripts/ratchet-gate.sh checks that pairing commit by commit. If the
        rise was NOT intended, the diff behind it is the finding.
        """
      else
        "Run `mix grappa.ratchet --update` and commit #{@record_path}.\n"
      end

    "#{@record_path} disagrees with the build (issue 2690):\n\n#{lines}\n\n#{todo}"
  end

  defp finding_line({:rose, key, rec, now}), do: "  rose        `#{key}`  #{rec} -> #{now}"
  defp finding_line({:fell, key, rec, now}), do: "  fell        `#{key}`  #{rec} -> #{now}"
  defp finding_line({:unrecorded, key, now}), do: "  unrecorded  `#{key}`  counted #{now}"
  defp finding_line({:gone, key, rec}), do: "  gone        `#{key}`  recorded #{rec}, no longer counted"

  @doc """
  Every quantity of the real tree, read off the beams in the compile path.
  Raises when the server beam is missing or no boundary is found: an empty
  count would be a gate that passes on nothing.
  """
  @spec counts() :: counts()
  def counts do
    dir = Mix.Project.compile_path()
    server_path = Path.join(dir, @server_beam)

    unless File.exists?(server_path), do: raise("ratchet: #{server_path} not found — nothing to count")

    deps = dir |> Path.join("*.beam") |> Path.wildcard() |> boundary_counts()

    if deps == %{}, do: raise("ratchet: no boundary under lib/ in #{dir} — the discovery is broken")

    server_path |> File.read!() |> server_counts() |> Map.merge(deps)
  end

  defp server_counts(beam) do
    %{
      "state_keys:#{@server_name}" => state_keys(beam),
      "handle_call_clauses:#{@server_name}" => clauses(beam, {:handle_call, 3}),
      "handle_info_clauses:#{@server_name}" => clauses(beam, {:handle_info, 2})
    }
  end

  defp boundary_counts(paths) do
    for path <- paths,
        {file, n} <- [boundary_deps(File.read!(path))],
        String.starts_with?(Path.relative_to_cwd(file), "lib/"),
        into: %{} do
      {"deps:" <> String.replace_prefix(Path.basename(path, ".beam"), "Elixir.", ""), n}
    end
  end

  @doc "Fields of the module's `@type t` map, from the compiled typespec. Raises if `t` is not a map literal."
  @spec state_keys(binary()) :: non_neg_integer()
  def state_keys(beam) do
    {:ok, types} = Code.Typespec.fetch_types(beam)

    case for({kind, {:t, {:type, _, :map, fields}, []}} <- types, kind in [:type, :opaque], do: fields) do
      [fields] when is_list(fields) -> length(fields)
      _ -> raise "ratchet: the module has no `@type t` written as a map literal — cannot count its state keys"
    end
  end

  @doc "Clauses the compiler kept for one function, from the beam's debug_info. 0 when it is not defined."
  @spec clauses(binary(), {atom(), arity()}) :: non_neg_integer()
  def clauses(beam, name_arity) do
    {:ok, {mod, [debug_info: {:debug_info_v1, backend, data}]}} = :beam_lib.chunks(beam, [:debug_info])
    {:ok, %{definitions: definitions}} = backend.debug_info(:elixir_v1, mod, data, [])

    case List.keyfind(definitions, name_arity, 0) do
      {_, _, _, clauses} -> length(clauses)
      nil -> 0
    end
  end

  @doc "The declaring file and `deps:` length of a boundary, or `nil` when the module declares none."
  @spec boundary_deps(binary()) :: {String.t(), non_neg_integer()} | nil
  def boundary_deps(beam) do
    {:ok, {_, [attributes: attributes]}} = :beam_lib.chunks(beam, [:attributes])

    case Keyword.get(attributes, Boundary) do
      [%{opts: opts, pos: %{file: file}}] -> {file, length(Keyword.get(opts, :deps, []))}
      nil -> nil
    end
  end

  @doc """
  The known-answer control: the fixture's counts must be the known answers,
  a record equal to them must pass, and one with a state key fewer must fail
  as a rise. `{:error, why}` when any of the three does not hold.
  """
  @spec self_test() :: :ok | {:error, String.t()}
  def self_test do
    counts = fixture_counts()
    record = Map.new(counts, fn {k, v} -> {Atom.to_string(k), v} end)
    red = Map.update!(record, "state_keys", &(&1 - 1))

    cond do
      counts != @fixture_answers ->
        {:error, "the fixture counted #{inspect(counts)}; the known answer is #{inspect(@fixture_answers)}"}

      check(record, record) != :ok ->
        {:error, "a record equal to the fixture's counts did not pass (the green control)"}

      check(record, red) != {:error, [{:rose, "state_keys", 2, 3}]} ->
        {:error, "a record one state key short did not fail as a rise (the red control)"}

      true ->
        :ok
    end
  end

  @doc "The fixture's counts, through the same counters as the real tree. The module is purged afterwards."
  @spec fixture_counts() :: fixture_counts()
  def fixture_counts do
    name = "Grappa.RatchetFixture.K#{System.unique_integer([:positive])}"

    [{mod, beam}] = Code.compile_string(fixture_source(name), "ratchet_fixture.ex")

    try do
      %{
        state_keys: state_keys(beam),
        handle_call_clauses: clauses(beam, {:handle_call, 3}),
        handle_info_clauses: clauses(beam, {:handle_info, 2}),
        deps:
          case boundary_deps(beam) do
            {_, n} -> n
            nil -> nil
          end
      }
    after
      :code.delete(mod)
      :code.purge(mod)
    end
  end

  # `@compile {:debug_info, true}` is load-bearing: the counters read the
  # debug_info chunk, and the GLOBAL compiler option is not ours to trust.
  # Measured: under `mix test` it is `false`, the fixture then carries no
  # chunk, and `Code.Typespec.fetch_types/1` answers `:error`. The real tree is
  # compiled by `mix compile` with the project's options and keeps its chunk.
  defp fixture_source(name) do
    """
    defmodule #{name} do
      @compile {:debug_info, true}
      use Boundary, deps: [Grappa.RatchetFixture.DepA, Grappa.RatchetFixture.DepB]
      use GenServer

      @type t :: %{optional(:c) => term(), a: integer(), b: atom()}

      @impl true
      def init(arg), do: {:ok, arg}

      @impl true
      def handle_call(:a, _from, state), do: {:reply, :a, state}
      def handle_call(:b, _from, state), do: {:reply, :b, state}

      @impl true
      def handle_info(_msg, state), do: {:noreply, state}
    end
    """
  end

  @doc "Serialise the record: a header, then one sorted `key = count` line per quantity."
  @spec render(counts()) :: String.t()
  def render(counts) do
    body = counts |> Enum.sort() |> Enum.map_join("\n", fn {key, n} -> "#{key} = #{n}" end)

    """
    # GENERATED by `mix grappa.ratchet --update` (issue 2690); see that task's moduledoc.
    #
    # One line per counted quantity, read off the build:
    #   state_keys:<mod>           fields of the module's `@type t` map
    #   handle_call_clauses:<mod>  clauses of handle_call/3 the compiler kept
    #   handle_info_clauses:<mod>  clauses of handle_info/2 the compiler kept
    #   deps:<boundary>            length of `deps:` in its `use Boundary` (lib/ only)
    #
    # A value that RISES is bumped here AND named in backticks on a
    # docs/DESIGN_NOTES.md line in the same commit (scripts/ratchet-gate.sh).
    #{body}
    """
  end

  @doc "Parse the record. Strict: any other line, a duplicated key or an empty record is an error."
  @spec parse(String.t()) :: {:ok, counts()} | {:error, String.t()}
  def parse(text) do
    text
    |> String.split("\n")
    |> Enum.reject(&(String.trim(&1) == "" or String.starts_with?(&1, "#")))
    |> parse_lines(%{})
  end

  defp parse_lines([], acc) when map_size(acc) == 0, do: {:error, "no `key = integer` line at all"}
  defp parse_lines([], acc), do: {:ok, acc}

  defp parse_lines([line | rest], acc) do
    case Regex.run(@line_re, line) do
      [_, key, _] when is_map_key(acc, key) -> {:error, "key #{key} appears twice"}
      [_, key, n] -> parse_lines(rest, Map.put(acc, key, String.to_integer(n)))
      nil -> {:error, "expected `key = integer`, got: #{line}"}
    end
  end

  defp do_check(counts) do
    record = read_record!()

    case check(counts, record) do
      :ok ->
        Mix.shell().info(
          "#{@record_path}: #{map_size(counts)} quantities agree with the build " <>
            "(#{@server_name}: #{counts["state_keys:#{@server_name}"]} state keys, " <>
            "#{counts["handle_call_clauses:#{@server_name}"]} handle_call + " <>
            "#{counts["handle_info_clauses:#{@server_name}"]} handle_info clauses; " <>
            "#{map_size(counts) - 3} boundaries)."
        )

      {:error, findings} ->
        abort(failure_message(findings))
    end
  end

  defp do_update(counts) do
    File.mkdir_p!(Path.dirname(@record_path))
    File.write!(@record_path, render(counts))
    Mix.shell().info("wrote #{@record_path}: #{map_size(counts)} quantities.")
  end

  defp read_record! do
    with {:ok, text} <- File.read(@record_path),
         {:ok, record} <- parse(text) do
      record
    else
      {:error, reason} when is_atom(reason) -> raise "cannot read #{@record_path}: #{:file.format_error(reason)}"
      {:error, message} -> raise "#{@record_path} is malformed: #{message}"
    end
  end

  # no_return() because it is one: every caller is a tail position that must
  # not continue (the reason `mix grappa.wire_pin`'s abort/1 carries it).
  @spec abort(String.t()) :: no_return()
  defp abort(message) do
    Mix.shell().error(message)
    exit({:shutdown, 1})
  end
end
