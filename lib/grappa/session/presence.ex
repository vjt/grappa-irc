defmodule Grappa.Session.Presence do
  @moduledoc """
  Pure presence-watch mechanics for `/notify` (GH #247): upstream
  command building (MONITOR / WATCH) and the authoritative
  online/offline state map with baseline-vs-transition semantics.

  ## Why this exists

  The watch list is DB-owned (`Grappa.Notify`); MONITOR/WATCH
  registrations live on the upstream connection and die with it.
  `Grappa.Session.Server` re-arms on every (re)connect at end-of-MOTD
  (376/422 — the earliest point past the full 005 burst, which is when
  the mechanism pick from `Grappa.Session.ISupport.presence_mechanism/1`
  is known; 001 is too early). This module owns the two pure halves of
  that work:

    * **Command building** — the watch list rendered as upstream lines,
      chunked under the 512-byte IRC line budget (`MONITOR + a,b,c` /
      `WATCH +a +b`).
    * **State map** — `%{folded_nick => :online | :offline | :unknown}`.
      Seeded `:unknown` on arm; each MONITOR/WATCH report classifies as
      `:initial` (first report after arm — paint the dot, no toast) or
      `:transition` (a genuine online↔offline flip — toast-eligible),
      or dedupes to `:unchanged`. This is the issue's baseline-snapshot
      rule: adding a large list must not fire a notification storm.

  Keys are rfc1459-folded via `Grappa.IRC.Identifier.canonical_nick/1`
  — same fold as every other server-side nick compare (GH #121).

  ## Purity contract

  No side effects, no process state. `Grappa.Session.Server` holds the
  map on its state and sends the built commands via its `Client`.
  """

  alias Grappa.IRC.Identifier
  alias Grappa.Session.ISupport

  @typedoc "Live presence of one watched nick."
  @type presence :: :online | :offline | :unknown

  @typedoc "Authoritative per-session presence map, keyed by folded nick."
  @type state_map :: %{String.t() => presence()}

  @typedoc """
  Classification of one presence report against the current map:
  `:initial` — first report after arm (baseline snapshot; dot, no
  toast); `:transition` — genuine online↔offline flip (toast-eligible).
  """
  @type change_kind :: :initial | :transition

  # Conservative payload budget per line: 512 bytes minus CRLF minus
  # "MONITOR + " / "WATCH " command overhead, minus slack for a server
  # relaying with a prefix. Chunking at 400 keeps every mechanism's
  # frame comfortably inside RFC 1459's limit without per-command
  # arithmetic.
  @line_budget 400

  # ---------------------------------------------------------------------------
  # Command building
  # ---------------------------------------------------------------------------

  @doc """
  The upstream lines that arm the whole watch list after registration.
  `[]` for `:none` (no mechanism advertised — v1 has no ISON fallback)
  or an empty list.

  MONITOR takes comma-separated targets (`MONITOR + a,b,c`); WATCH
  takes individually `+`-prefixed ones (`WATCH +a +b`). Both are
  chunked under the line budget. Limits are NOT enforced here — the
  server is the authority; `ERR_MONLISTFULL` (734) / `ERR_TOOMANYWATCH`
  (512) are surfaced as presence errors by the numeric handlers.
  """
  @spec arm_commands(ISupport.presence_mechanism(), [String.t()]) :: [String.t()]
  def arm_commands(_mechanism, []), do: []
  def arm_commands({:monitor, _limit}, nicks), do: monitor_commands("+", nicks)
  def arm_commands({:watch, _limit}, nicks), do: watch_commands("+", nicks)
  def arm_commands(:none, _nicks), do: []

  @doc """
  The upstream lines that add `nicks` to an already-armed session
  (live `/notify add` while connected). Same shapes as `arm_commands/2`.
  """
  @spec add_commands(ISupport.presence_mechanism(), [String.t()]) :: [String.t()]
  def add_commands(mechanism, nicks), do: arm_commands(mechanism, nicks)

  @doc """
  The upstream lines that remove `nicks` from an armed session
  (`MONITOR - a,b` / `WATCH -a -b`).
  """
  @spec remove_commands(ISupport.presence_mechanism(), [String.t()]) :: [String.t()]
  def remove_commands(_mechanism, []), do: []
  def remove_commands({:monitor, _limit}, nicks), do: monitor_commands("-", nicks)
  def remove_commands({:watch, _limit}, nicks), do: watch_commands("-", nicks)
  def remove_commands(:none, _nicks), do: []

  # ---------------------------------------------------------------------------
  # State map
  # ---------------------------------------------------------------------------

  @doc """
  Seeds the presence map for `nicks` — every entry `:unknown` until the
  first upstream report. Folded keys.
  """
  @spec seed([String.t()]) :: state_map()
  def seed(nicks) when is_list(nicks) do
    Map.new(nicks, fn nick -> {Identifier.canonical_nick(nick), :unknown} end)
  end

  @doc """
  Applies one upstream presence report to the map.

  Returns `{:changed, kind, map}` when the report changes the map —
  `kind` is `:initial` for the first report on an `:unknown` entry
  (baseline snapshot) and `:transition` for a genuine flip — or
  `:unchanged` for a duplicate report. Reports for nicks NOT in the
  map (a stale reply after `/notify del`, or an upstream echo we never
  asked for) are `:unchanged` — never invent entries the DB list
  doesn't carry.
  """
  @spec apply_report(state_map(), String.t(), :online | :offline) ::
          {:changed, change_kind(), state_map()} | :unchanged
  def apply_report(map, nick, presence)
      when is_map(map) and is_binary(nick) and presence in [:online, :offline] do
    key = Identifier.canonical_nick(nick)

    case Map.fetch(map, key) do
      :error -> :unchanged
      {:ok, ^presence} -> :unchanged
      {:ok, :unknown} -> {:changed, :initial, Map.put(map, key, presence)}
      {:ok, _flip} -> {:changed, :transition, Map.put(map, key, presence)}
    end
  end

  @doc """
  Adds `nicks` (folded, `:unknown`) to an armed map — the live
  `/notify add` path. Existing entries keep their known state.
  """
  @spec track(state_map(), [String.t()]) :: state_map()
  def track(map, nicks) when is_map(map) and is_list(nicks) do
    Enum.reduce(nicks, map, fn nick, acc ->
      Map.put_new(acc, Identifier.canonical_nick(nick), :unknown)
    end)
  end

  @doc """
  Drops `nicks` (folded) from the map — the live `/notify del` /
  `clear` path.
  """
  @spec untrack(state_map(), [String.t()]) :: state_map()
  def untrack(map, nicks) when is_map(map) and is_list(nicks) do
    Map.drop(map, Enum.map(nicks, &Identifier.canonical_nick/1))
  end

  # ---------------------------------------------------------------------------
  # Private — chunked command rendering
  # ---------------------------------------------------------------------------

  # MONITOR ± with comma-joined targets: "MONITOR + a,b,c".
  @spec monitor_commands(String.t(), [String.t()]) :: [String.t()]
  defp monitor_commands(sign, nicks) do
    nicks
    |> chunk_by_budget(_joiner_overhead = 1)
    |> Enum.map(fn chunk -> "MONITOR #{sign} #{Enum.join(chunk, ",")}" end)
  end

  # WATCH ± with per-target sign: "WATCH +a +b" / "WATCH -a -b".
  @spec watch_commands(String.t(), [String.t()]) :: [String.t()]
  defp watch_commands(sign, nicks) do
    nicks
    # separator " " + sign prefix per target = 2 bytes of overhead
    |> chunk_by_budget(2)
    |> Enum.map(fn chunk ->
      "WATCH " <> Enum.map_join(chunk, " ", fn nick -> sign <> nick end)
    end)
  end

  # Greedy chunker: pack nicks until the payload would exceed the
  # budget. `overhead` is the per-nick joining cost (comma vs
  # space+sign). A single nick longer than the budget still ships alone
  # — the server rejects it, we don't silently drop it.
  @spec chunk_by_budget([String.t()], pos_integer()) :: [[String.t()]]
  defp chunk_by_budget(nicks, overhead) do
    {chunks, last, _} =
      Enum.reduce(nicks, {[], [], 0}, fn nick, {chunks, current, size} ->
        cost = byte_size(nick) + overhead

        cond do
          current == [] -> {chunks, [nick], cost}
          size + cost > @line_budget -> {[Enum.reverse(current) | chunks], [nick], cost}
          true -> {chunks, [nick | current], size + cost}
        end
      end)

    case last do
      [] -> Enum.reverse(chunks)
      _ -> Enum.reverse([Enum.reverse(last) | chunks])
    end
  end
end
