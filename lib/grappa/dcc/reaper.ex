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
  `Grappa.Uploads.Reaper` — see `Grappa.Dcc.delete/1` for why the
  tombstone buys nothing here. NOT because this spool is private: since
  issue 2127 its URL is as public as an upload's. File unlink FIRST, then
  the row — the same ordering, so a racing `GET /dcc_files/:slug` between
  the two sees a live row and ENOENT on disk, i.e. a 404, rather than a
  row pointing at nothing.

  🔴 Ungating the route made this sweep the ONLY thing that ever revokes
  access to a spooled file. Before issue 2127 a leaked URL still met
  `:authn`; now the 26-char slug IS the credential, so `expires_at` —
  enforced here and at `Grappa.Dcc.get_by_slug/1` — is the whole
  revocation story. That is the same posture `/uploads/:slug` has had
  since UX-6-B1, and it is why the retention ceiling is a ruling
  (`Grappa.Dcc` moduledoc) rather than a default.

  ## This is ONE of three reaping axes, and it cannot be the only one

  Issue 2089's rule is that nothing a stranger pushed persists un-reaped,
  and three different things can persist:

    1. A HELD offer nobody answered. Not here — a held offer lives in the
       session process (it is a peer's live TCP endpoint, worthless once
       that process is gone), and it is reaped by that process's own
       per-offer timer. A crash reaps it for free.
    2. A DELIVERED file past its retention. This module, `sweep/2`.
    3. BYTES NO ROW POINTS AT. `Grappa.Dcc.Transfer` removes a partial
       spool inline on every failure arm, and that stays the prompt path.
       But inline cleanup only runs when the code that wrote the bytes
       lives to reach it, and there are two ways it does not (issue 2404):
       the session dies before it handles the transfer's result (the task
       finishes, its report goes to a dead pid, no row is ever written),
       and the task itself is killed mid-drain — a restart, a crash —
       before its failure arm runs. So this module, `sweep_orphans/3`, too.

  #2089 called axis 3 not delegable to a sweeper, on the ground that an
  orphan no row points at is exactly what no sweep can find. That holds
  only for a sweep that enumerates ROWS. The directory enumerates the
  bytes, the table says which of them are recorded, and the difference is
  the orphan set — derived from two things that already exist, so there
  is no pending-transfer record to keep in step with either.

  🔴 **The orphan pass deletes what it does not recognise, so it refuses
  to run on a root it may not own.** The uploads and peer-avatar stores
  name their files with the same 26-character slug shape, and NONE of
  their files has a `dcc_files` row — pointed at either root, the pass
  would unlink every upload or cached avatar older than the grace. So it
  first compares its root with both (`protected_roots/0`) and, if one is,
  contains or lies inside the other, it removes nothing and logs an error
  naming both paths, on every tick, until the operator moves
  `DCC_STORAGE_ROOT`. The check lives HERE, beside the unlink, rather
  than at boot: it guards the one verb that can do the damage, and it
  arrives with a hot reload instead of waiting for a restart. The expiry
  pass is not gated — it only ever unlinks a slug a `dcc_files` row
  names, 128 random bits no other store will have minted.
  """

  # issue 2404 — `Grappa.Uploads` and `Grappa.Avatars` for their storage
  # roots alone, the two directories the orphan pass must never sweep. No
  # cycle: neither names this module or `Grappa.Dcc`.
  use Boundary, top_level?: true, deps: [Grappa.Avatars, Grappa.Dcc, Grappa.Uploads]

  use GenServer

  alias Grappa.{Avatars, Dcc, Uploads}
  alias Grappa.Dcc.SpoolFile

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name(), storage_root: Path.t()]

  @typedoc "Another store's root, named for the refusal message."
  @type protected_root :: {atom(), Path.t()}

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

  @doc """
  Synchronous orphan sweep (issue 2404) — unlinks every spool file that
  no row points at and that nothing has written for
  `Grappa.Dcc.orphan_grace_seconds/0`. Returns how many it removed.

  The age is the file's mtime, and it is what tells an orphan from a
  transfer still in flight: both are bytes with no row, but a live
  transfer writes on every chunk, so its file cannot look as old as the
  grace (see the attribute in `Grappa.Dcc`).

  REFUSES — removes nothing, logs an error naming both paths, returns
  `{:error, {:root_overlap, name}}` — when `storage_root` is, contains or
  lies inside any of `protected_roots` (see the moduledoc). The tick
  passes `protected_roots/0`; the argument is explicit so the refusal is
  testable on directories of the test's own.

  `now` is injectable, as for `sweep/2`. A separate pass rather than more
  work inside `sweep/2`: that one retires ROWS and this one has none to
  retire, so they share no step past the unlink.
  """
  @spec sweep_orphans(Path.t(), [protected_root()], DateTime.t()) ::
          {:ok, non_neg_integer()} | {:error, {:root_overlap, atom()}}
  def sweep_orphans(storage_root, protected_roots, %DateTime{} = now) when is_list(protected_roots) do
    case Enum.find(protected_roots, fn {_, root} -> overlap?(storage_root, root) end) do
      nil ->
        {:ok, unlink_orphans(storage_root, now)}

      {name, root} ->
        # Both paths ride in the MESSAGE: the Logger metadata allowlist
        # (`config/config.exs`) is closed, and a path is not on it.
        Logger.error(
          "dcc reaper: orphan sweep refused - the DCC root #{storage_root} overlaps the #{name} root " <>
            "#{root} (one is, contains or lies inside the other); give DCC_STORAGE_ROOT a directory of its own"
        )

        {:error, {:root_overlap, name}}
    end
  end

  # The two other stores whose files share the slug shape, read from their
  # own `:persistent_term` seams on every tick rather than captured at
  # init: a value captured into the state would mean a state field, and
  # the guard would then wait for a restart.
  @spec protected_roots() :: [protected_root()]
  defp protected_roots, do: [uploads: Uploads.storage_root(), peer_avatars: Avatars.storage_root()]

  # One path is, or lies inside, the other — compared by SEGMENTS after
  # `Path.expand/1`, so `/data/up` is not taken for a parent of
  # `/data/uploads`, and a trailing slash or a `..` changes nothing. It is
  # lexical: a symlink aliasing one root under another name is not seen.
  defp overlap?(path, other) do
    segments = path |> Path.expand() |> Path.split()
    other_segments = other |> Path.expand() |> Path.split()
    prefix?(segments, other_segments) or prefix?(other_segments, segments)
  end

  defp prefix?(path, prefix), do: Enum.take(path, length(prefix)) == prefix

  defp unlink_orphans(storage_root, now) do
    cutoff = DateTime.to_unix(now) - Dcc.orphan_grace_seconds()

    # Age BEFORE the row lookup: the lookup is then the last step between
    # the decision and the unlink, and a tick with nothing stale — almost
    # every tick — asks the database nothing.
    storage_root
    |> File.ls!()
    |> Enum.filter(&stale?(storage_root, &1, cutoff))
    |> Dcc.untracked_slugs()
    |> Enum.reduce(0, fn slug, acc ->
      case File.rm(Path.join(storage_root, slug)) do
        :ok ->
          acc + 1

        # Gone since the stat: the inline cleanup got there first.
        {:error, :enoent} ->
          acc

        {:error, reason} ->
          Logger.error("dcc reaper failure", slug: slug, error: inspect({:fs, reason}))
          acc
      end
    end)
  end

  defp stale?(storage_root, name, cutoff) do
    case File.stat(Path.join(storage_root, name), time: :posix) do
      {:ok, %File.Stat{mtime: mtime}} ->
        mtime <= cutoff

      {:error, :enoent} ->
        false

      {:error, reason} ->
        Logger.error("dcc reaper failure", slug: name, error: inspect({:fs, reason}))
        false
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
    now = DateTime.utc_now()
    {:ok, n} = sweep(state.storage_root, now)
    if n > 0, do: Logger.info("dcc reaper swept", affected: n)

    case sweep_orphans(state.storage_root, protected_roots(), now) do
      {:ok, 0} -> :ok
      {:ok, orphans} -> Logger.info("dcc reaper removed spool files no row pointed at", affected: orphans)
      # Already logged, as an error, by the refusal itself.
      {:error, {:root_overlap, _}} -> :ok
    end

    # Rescheduled from `state.interval_ms`, never from the module default:
    # a tick that rebuilt the interval from the literal would discard the
    # injected one and turn a deterministic test into a rare red.
    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
