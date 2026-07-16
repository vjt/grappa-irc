defmodule Grappa.Net.PtrCache do
  @moduledoc """
  TTL-honoring, non-blocking ETS cache of reverse-DNS (PTR) names for
  source-bind IP addresses — #252 vhost self-service.

  ## Why

  The vhost settings sub-page renders each pool address by its human
  **name** (its cloak rDNS string). The DNS is the single source of
  truth (vjt 2026-07-15) — no name column, no DB copy. Resolving on the
  request hot path would block the `GET /me/settings/vhost` response on
  a nameserver round-trip, so this cache sits in front of
  `Grappa.Net.PtrResolver`:

    * `names_for/1` is a LOCK-FREE read: it reads the ETS table directly
      (no GenServer round-trip) and returns `%{address => name | nil}`
      immediately. A cold/expired entry reads as `nil` (the controller
      falls back to the raw IP) and fires an out-of-band `{:ensure, _}`
      cast so the NEXT read is warm. The GET therefore NEVER blocks on a
      cold cache.
    * `warm/1` is the synchronous counterpart (resolve now, cache, return
      the name) — used by tests and available for a future operator
      "refresh names" verb; NOT on any request hot path.

  ## Strategy: lazy, not warm-at-boot (DESIGN_NOTES 2026-07-15)

  The allowed vhost set is PER-SUBJECT (generally-available ∪ in_pool ∪
  the subject's grants), so a warm-at-boot + scheduled-refresh design
  would still need a lazy path for freshly-granted addresses AND a
  scheduler whose housekeeping can drift. Lazy resolve-on-first-read
  covers every address uniformly with no scheduler; cic re-reads the
  view on entering the sub-page, so the steady state always shows names.

  ## TTL

  A resolved name is cached for its record TTL, clamped to
  `[min_ttl_ms, max_ttl_ms]` (floor avoids thrash on tiny TTLs; cap
  bounds staleness so a cloak rename eventually propagates). A no-PTR
  address is negatively cached (`:none`) for `negative_ttl_ms` (stable —
  not every address has a name); a transient resolver error backs off for
  the shorter `error_ttl_ms`. An entry whose `expires_at` has passed reads
  as a miss and re-resolves.

  ## Reusable instances / test seam

  The registered `:name` doubles as the ETS table atom, and `:resolver`
  is an injected `(address -> Grappa.Net.PtrResolver.result())` fun
  (default: the real resolver). Tests start isolated instances with a
  stub resolver + `min_ttl_ms: 0`, so the suite stays `async: true` and
  never touches real DNS. The app-wide singleton is started in
  `Grappa.Application` with the boot-configured resolver.

  ## Test isolation (singleton)

  The app singleton (`name: __MODULE__`, ETS table `Grappa.Net.PtrCache`)
  is shared across the whole `mix test` run — but keyed by IP-literal
  string, so tests using distinct addresses never collide. Callers that
  DO share an address must stay `async: false` (none today).
  """
  use GenServer
  use Boundary, top_level?: true, deps: [Grappa.Net.PtrResolver]

  alias Grappa.Net.PtrResolver

  require Logger

  @min_ttl_ms Application.compile_env(:grappa, [:vhost_ptr_cache, :min_ttl_ms], 60_000)
  @max_ttl_ms Application.compile_env(:grappa, [:vhost_ptr_cache, :max_ttl_ms], 24 * 60 * 60_000)
  @negative_ttl_ms Application.compile_env(:grappa, [:vhost_ptr_cache, :negative_ttl_ms], 60 * 60_000)
  @error_ttl_ms Application.compile_env(:grappa, [:vhost_ptr_cache, :error_ttl_ms], 60_000)

  @typedoc "An ETS row: the address, its resolved name (or `:none` for no-PTR/error), and its monotonic-ms expiry."
  @type entry :: {String.t(), String.t() | :none, integer()}

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  The app singleton's ETS table atom — the `Grappa.Health` `:ets`
  substrate check couples on this so a rename surfaces a health failure
  on the next deploy rather than silently diverging.
  """
  @spec table_name() :: __MODULE__
  def table_name, do: __MODULE__

  @doc """
  Non-blocking batch read: `%{address => name | nil}` for the app
  singleton. `nil` means "no name available right now" (cold, no-PTR, or
  a resolver error) — the caller falls back to the raw IP. A cold/expired
  address triggers an out-of-band resolve so a later read returns its name.
  """
  @spec names_for([String.t()]) :: %{optional(String.t()) => String.t() | nil}
  def names_for(addresses) when is_list(addresses), do: names_for(__MODULE__, addresses)

  @doc "As `names_for/1`, against a specific cache instance (reusable-instance / test seam)."
  @spec names_for(atom(), [String.t()]) :: %{optional(String.t()) => String.t() | nil}
  def names_for(cache, addresses) when is_atom(cache) and is_list(addresses) do
    now = System.monotonic_time(:millisecond)

    {names, cold} =
      Enum.reduce(addresses, {%{}, []}, fn address, {names, cold} ->
        case lookup_fresh(cache, address, now) do
          {:fresh, :none} -> {Map.put(names, address, nil), cold}
          {:fresh, name} -> {Map.put(names, address, name), cold}
          :miss -> {Map.put(names, address, nil), [address | cold]}
        end
      end)

    case Enum.uniq(cold) do
      [] -> :ok
      cold -> GenServer.cast(cache, {:ensure, cold})
    end

    names
  end

  @doc """
  Synchronously resolve + cache `address` (app singleton), returning the
  name or `nil` (no-PTR / resolver error). Blocks the caller on the
  resolver — NOT for a request hot path; use `names_for/1` there.
  """
  @spec warm(String.t()) :: String.t() | nil
  def warm(address) when is_binary(address), do: warm(__MODULE__, address)

  @doc "As `warm/1`, against a specific cache instance."
  @spec warm(atom(), String.t()) :: String.t() | nil
  def warm(cache, address) when is_atom(cache) and is_binary(address) do
    GenServer.call(cache, {:warm, address})
  end

  ## GenServer

  @impl GenServer
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    _ = :ets.new(name, [:named_table, :set, :public, read_concurrency: true])

    state = %{
      table: name,
      resolver: Keyword.get(opts, :resolver, &PtrResolver.resolve/1),
      min_ttl_ms: Keyword.get(opts, :min_ttl_ms, @min_ttl_ms),
      max_ttl_ms: Keyword.get(opts, :max_ttl_ms, @max_ttl_ms),
      negative_ttl_ms: Keyword.get(opts, :negative_ttl_ms, @negative_ttl_ms),
      error_ttl_ms: Keyword.get(opts, :error_ttl_ms, @error_ttl_ms)
    }

    {:ok, state}
  end

  @impl GenServer
  def handle_call({:warm, address}, _, state) do
    {:reply, do_resolve(state, address), state}
  end

  @impl GenServer
  def handle_cast({:ensure, addresses}, state) do
    now = System.monotonic_time(:millisecond)

    Enum.each(addresses, fn address ->
      # Re-check under the mailbox: a sibling cast (or warm) in this window
      # may already have resolved it — skip so concurrent cold reads for the
      # same address collapse to a single resolver hit.
      case lookup_fresh(state.table, address, now) do
        {:fresh, _} -> :ok
        :miss -> _ = do_resolve(state, address)
      end
    end)

    {:noreply, state}
  end

  # Resolve `address`, write the result to ETS with the appropriate expiry,
  # and return the name (or `nil` for no-PTR / error). Runs inside the
  # GenServer (cast/call) — never on the caller's request path.
  @spec do_resolve(map(), String.t()) :: String.t() | nil
  defp do_resolve(state, address) do
    now = System.monotonic_time(:millisecond)

    case state.resolver.(address) do
      {:ok, name, ttl_seconds} ->
        :ets.insert(state.table, {address, name, now + clamp_ttl(state, ttl_seconds)})
        name

      :nxdomain ->
        :ets.insert(state.table, {address, :none, now + state.negative_ttl_ms})
        nil

      {:error, reason} ->
        :ets.insert(state.table, {address, :none, now + state.error_ttl_ms})
        Logger.warning("ptr resolve failed for #{address}", reason: reason)
        nil
    end
  end

  @spec clamp_ttl(map(), non_neg_integer()) :: non_neg_integer()
  defp clamp_ttl(state, ttl_seconds) do
    (ttl_seconds * 1000)
    |> max(state.min_ttl_ms)
    |> min(state.max_ttl_ms)
  end

  @spec lookup_fresh(atom(), String.t(), integer()) :: {:fresh, String.t() | :none} | :miss
  defp lookup_fresh(table, address, now) do
    case :ets.lookup(table, address) do
      [{^address, value, expires_at}] when now < expires_at -> {:fresh, value}
      _ -> :miss
    end
  end
end
