defmodule Grappa.Session.Backoff do
  @moduledoc """
  Per-`(subject, network_id)` exponential backoff for IRC reconnect
  attempts. ETS-backed so the failure counter survives the
  `Session.Server`'s `:transient` restart cycle.

  ## Why

  `Grappa.IRC.Client` carries a `@connect_failure_sleep_ms` throttle
  for `handle_continue/2`'s connect-fail branch (S18 H1), but a
  k-line / forced disconnect from upstream lands as `:tcp_closed`
  AFTER the connect succeeds — and that path returns `{:stop,
  :tcp_closed, _}` immediately, with no throttle. Each crash
  triggers a `:transient` respawn, the new Session.Server starts a
  fresh Client, the new Client connects, the upstream closes
  again, the loop continues at full restart rate. azzurra k-lined
  the bouncer's IP the first time this happened.

  This module adds a layer ABOVE the Client's per-attempt throttle:
  the failure count survives Session.Server crashes (lives in
  ETS owned by this GenServer at the Application level), so the
  next respawn waits exponentially longer before even trying.

  ## API contract

    * `wait_ms/2` — fast read, direct ETS lookup. Called from
      `Session.Server.handle_continue({:start_client, _}, _)` to
      decide whether to delay before spawning the Client.
    * `record_failure/2` — bumps the count; called from
      `Session.Server.terminate/2` on any non-`:normal` exit.
    * `record_success/2` — clears the entry; called from the 001
      RPL_WELCOME hook in `Session.Server` (we know the upstream
      accepted us, so prior failures are stale).

  Writes funnel through the GenServer to keep the read-modify-write
  of the count consistent under concurrent failures (two visitors
  on the same network crashing simultaneously). Reads are direct
  `:ets.lookup/2` from the caller (`:read_concurrency` set) so the
  Session.Server hot path takes no GenServer roundtrip.

  ## Tuning

  Defaults: 5s base × 2^(count-1), capped at 30 min, with ±25%
  jitter to avoid herd-respawn alignment. Override per-environment
  via `config :grappa, :session_backoff, base_ms: ..., cap_ms: ...`.
  Test config sets these to a few ms so retries don't dominate
  test runtime.

  Curve at defaults:

  | count | nominal wait |
  |-------|--------------|
  | 1     | 5s           |
  | 2     | 10s          |
  | 3     | 20s          |
  | 4     | 40s          |
  | 5     | 80s          |
  | 6     | 160s         |
  | 7     | 320s         |
  | 8     | 640s         |
  | 9     | 1280s        |
  | 10+   | 1800s (cap)  |

  After ~5 consecutive failures we're already at >1m wait; after 10
  we're at the 30-min cap. A k-line bouncer would idle for the cap
  duration between attempts instead of hammering — the IP K-line
  expires (typically 24h on azzurra) without further escalation.
  """
  use GenServer

  alias Grappa.Session

  @table :session_backoff_state
  @jitter_pct 25

  @base_ms Application.compile_env(:grappa, [:session_backoff, :base_ms], 5_000)
  @cap_ms Application.compile_env(:grappa, [:session_backoff, :cap_ms], 30 * 60 * 1_000)

  @typep entry :: {key(), pos_integer(), integer()}
  @typep key :: {Session.subject(), integer()}

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc """
  Milliseconds the caller should sleep before the next connect attempt
  for `(subject, network_id)`. `0` for fresh / cleared entries.

  Direct ETS lookup — no GenServer roundtrip.
  """
  @spec wait_ms(Session.subject(), integer()) :: non_neg_integer()
  def wait_ms(subject, network_id) when is_integer(network_id) do
    case :ets.lookup(@table, {subject, network_id}) do
      [] -> 0
      [{_, count, _}] -> compute_wait(count)
    end
  end

  @doc """
  Record a failed connect attempt for `(subject, network_id)`. Bumps
  the counter; the next `wait_ms/2` will return a longer delay.
  Asynchronous (cast).
  """
  @spec record_failure(Session.subject(), integer()) :: :ok
  def record_failure(subject, network_id) when is_integer(network_id) do
    GenServer.cast(__MODULE__, {:failure, {subject, network_id}})
  end

  @doc """
  Record a successful connect for `(subject, network_id)` — clears the
  entry so the next failure starts the exponential ladder over from
  scratch. Called on `001 RPL_WELCOME` (upstream accepted us, so any
  prior failure history is stale). Asynchronous (cast).
  """
  @spec record_success(Session.subject(), integer()) :: :ok
  def record_success(subject, network_id) when is_integer(network_id) do
    GenServer.cast(__MODULE__, {:success, {subject, network_id}})
  end

  @doc false
  @spec failure_count(Session.subject(), integer()) :: non_neg_integer()
  def failure_count(subject, network_id) when is_integer(network_id) do
    case :ets.lookup(@table, {subject, network_id}) do
      [] -> 0
      [{_, count, _}] -> count
    end
  end

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_cast({:failure, key}, state) do
    new_count =
      case :ets.lookup(@table, key) do
        [] -> 1
        [{_, c, _}] -> c + 1
      end

    :ets.insert(@table, {key, new_count, System.monotonic_time(:millisecond)})
    {:noreply, state}
  end

  def handle_cast({:success, key}, state) do
    :ets.delete(@table, key)
    {:noreply, state}
  end

  ## Internals

  @doc false
  @spec compute_wait(non_neg_integer()) :: non_neg_integer()
  def compute_wait(count) when count <= 0, do: 0

  def compute_wait(count) do
    # 2^(count-1) — count=1 → base, count=2 → 2*base, count=3 → 4*base.
    raw = @base_ms * trunc(:math.pow(2, count - 1))
    capped = min(raw, @cap_ms)
    jitter = trunc(capped * @jitter_pct / 100)
    # Window is [capped - jitter, capped + jitter]. :rand.uniform/1
    # returns 1..N, so center the spread on capped.
    capped - jitter + :rand.uniform(2 * jitter + 1) - 1
  end

  @doc false
  @spec base_ms() :: unquote(@base_ms)
  def base_ms, do: @base_ms

  @doc false
  @spec cap_ms() :: unquote(@cap_ms)
  def cap_ms, do: @cap_ms

  @doc false
  @spec entries() :: [entry()]
  def entries, do: :ets.tab2list(@table)
end
