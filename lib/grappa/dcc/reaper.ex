defmodule Grappa.Dcc.Reaper do
  @moduledoc """
  Periodic sweep of expired `dcc_files` rows + their on-disk bytes (issue
  2089) — the fifth reaper, and the SAME shape as the other four.

  Shared verb, separate noun: a `:permanent` GenServer under the main
  supervision tree, a 60s default interval, `:interval_ms` injectable for
  tests, per-row failures logged and stepped over. Copying that shape is
  the point — a bespoke sweeper for one more table would be a second
  answer to a question this tree already answers.

  Hard-deletes, like `Grappa.Avatars.Reaper` and unlike
  `Grappa.Uploads.Reaper`: a soft-delete exists there to protect a PUBLIC,
  cacheable URL that may be in flight, and this spool is served only
  behind `:authn` + `ResolveNetwork`. File unlink FIRST, then the row —
  the same ordering, so a racing `GET /networks/:id/dcc_files/:slug`
  between the two sees a live row and ENOENT on disk, i.e. a 404, rather
  than a row pointing at nothing.

  ## This is ONE of three reaping axes, and it cannot be the only one

  Issue 2089's rule is that nothing a stranger pushed persists un-reaped,
  and three different things can persist:

    1. A HELD offer nobody answered. Not here — a held offer lives in the
       session process (it is a peer's live TCP endpoint, worthless once
       that process is gone), and it is reaped by that process's own
       per-offer timer. A crash reaps it for free.
    2. A DELIVERED file past its retention. This module.
    3. A PARTIAL file from a transfer that aborted. **Not delegable to a
       sweeper, deliberately** — `Grappa.Dcc.Transfer` removes the partial
       spool inline on every failure arm, because the row that would let a
       sweeper find it is never written. An orphan nobody recorded is
       precisely what no sweep can enumerate.
  """

  use Boundary, top_level?: true, deps: [Grappa.Dcc]

  use GenServer

  alias Grappa.Dcc
  alias Grappa.Dcc.SpoolFile

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name(), storage_root: Path.t()]

  defstruct [:interval_ms, :storage_root]
  @type t :: %__MODULE__{interval_ms: pos_integer(), storage_root: Path.t()}

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired spool files, unlinks each and
  hard-deletes its row. `now` is injectable so a retention test does not
  have to wait out a real TTL.
  """
  @spec sweep(Path.t(), DateTime.t()) :: {:ok, non_neg_integer()}
  def sweep(storage_root, %DateTime{} = now) do
    deleted =
      now
      |> Dcc.list_expired()
      |> Enum.reduce(0, fn %SpoolFile{} = row, acc ->
        case unlink_then_delete(row, Path.join(storage_root, row.slug)) do
          :ok ->
            acc + 1

          {:error, reason} ->
            # The slug rides in metadata (an allowlisted key); the PATH
            # does not, and must not — `config/config.exs`'s Logger
            # allowlist is closed and deliberate.
            Logger.error("dcc reaper failure", slug: row.slug, error: inspect(reason))
            acc
        end
      end)

    {:ok, deleted}
  end

  defp unlink_then_delete(%SpoolFile{} = row, path) do
    case File.rm(path) do
      :ok -> :ok = Dcc.delete(row)
      # Already gone is success, not an error: the row is the thing that
      # must not survive, and leaving it because the bytes went missing
      # first would strand it forever.
      {:error, :enoent} -> :ok = Dcc.delete(row)
      {:error, reason} -> {:error, {:fs, reason}}
    end
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    storage_root = Keyword.fetch!(opts, :storage_root)

    # The bang is deliberate and is the #1945 lesson: an unwritable spool
    # root is a misconfigured deployment, and this runs inside the
    # supervision tree, so it takes the boot down rather than serve an
    # instance that silently cannot spool. Sound only while the root is
    # ABSOLUTE — a CWD-relative default is what killed the v1.5.0 cold
    # deploy on the jail with eacces.
    :ok = File.mkdir_p!(storage_root)

    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval, storage_root: storage_root}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    {:ok, n} = sweep(state.storage_root, DateTime.utc_now())
    if n > 0, do: Logger.info("dcc reaper swept", affected: n)

    # Rescheduled from `state.interval_ms`, never from the module default:
    # a tick that rebuilt the interval from the literal would discard the
    # injected one and turn a deterministic test into a rare red.
    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
