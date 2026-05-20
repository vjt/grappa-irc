defmodule Grappa.Uploads.Reaper do
  @moduledoc """
  Periodic sweep of expired upload rows + on-disk files.

  Same shape as `Grappa.Visitors.Reaper` — `:permanent` GenServer
  under the main application supervision tree. Default interval is
  60s, configurable via `:interval_ms` start opt for tests.

  ## Sweep ordering — file unlink BEFORE row soft-delete

  See `Grappa.Uploads` moduledoc "File-first, row-after invariant"
  for the full rationale. Summary: a racing GET between unlink +
  soft-delete sees the row live + ENOENT on disk → handler returns
  404. Inverting the order would let the row read as soft-deleted
  while the file is still on disk — a leaked window during which
  the bytes are reachable from the host fs but not from the public
  surface (gives no value, costs disk).

  Per-row failures log + continue — one bad row does not stop the
  sweep.

  ## Storage root

  The on-disk directory is `:storage_root` passed via start opts.
  Production callers pass `runtime/uploads` (set in the application
  supervisor); tests inject a per-test temp dir + clean it via
  `on_exit/1`.

  The Reaper performs `File.mkdir_p/1` on `storage_root` in
  `init/1` so a fresh deploy doesn't need a separate bootstrap
  step — same module owns both the read + write of the directory.

  ## AdminEvents

  Per-row reap emits `:upload_reaped` with the slug + subject
  attribution. End-of-sweep emits `:uploads_swept` with the count
  (suppressed when 0 to avoid flooding the 200-cap ring buffer
  with 1440 idle ticks/day, same pattern as Visitors.Reaper).
  Operator-triggered sweeps (`bin/grappa reap-uploads`) bypass the
  suppression so the operator sees their click landed.

  ## Boundary

  Top-level (mirrors Visitors.Reaper). Deps: AdminEvents, Uploads.
  """

  use Boundary, top_level?: true, deps: [Grappa.AdminEvents, Grappa.Uploads]

  use GenServer

  alias Grappa.{AdminEvents, Uploads}
  alias Grappa.AdminEvents.Wire, as: AdminWire
  alias Grappa.Uploads.Upload

  require Logger

  @default_interval_ms 60_000

  @type opts :: [
          interval_ms: pos_integer(),
          name: GenServer.name(),
          storage_root: Path.t()
        ]

  defstruct [:interval_ms, :storage_root]

  @type t :: %__MODULE__{
          interval_ms: pos_integer(),
          storage_root: Path.t()
        }

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired uploads + unlinks + soft-
  deletes each. Returns `{:ok, count}` with the number of rows
  enumerated (per-row failures still count toward the total because
  the enumeration is the contract; the operator-facing failure
  surface is the `Logger.error` line, not the return value).

  `now` is injectable for time-sensitive tests; production callers
  omit it.
  """
  @spec sweep(Path.t(), DateTime.t()) :: {:ok, non_neg_integer()}
  def sweep(storage_root, %DateTime{} = now) do
    expired = Uploads.list_expired(now)

    deleted =
      Enum.reduce(expired, 0, fn %Upload{} = up, acc ->
        path = Uploads.storage_path(storage_root, up.slug)

        case unlink_then_soft_delete(up, path, now) do
          :ok ->
            :ok =
              AdminEvents.record(AdminWire.upload_reaped(up.id, up.slug, subject_kind(up), subject_id(up)))

            acc + 1

          {:error, reason} ->
            Logger.error("uploads reaper failure",
              upload_id: up.id,
              slug: up.slug,
              error: inspect(reason)
            )

            acc
        end
      end)

    {:ok, deleted}
  end

  defp unlink_then_soft_delete(%Upload{} = up, path, now) do
    case File.rm(path) do
      :ok ->
        soft_delete(up, now)

      {:error, :enoent} ->
        # File already gone (manual cleanup, prior partial sweep,
        # disk reformat). Soft-delete the row to bring the registry
        # back in sync.
        soft_delete(up, now)

      {:error, reason} ->
        # Permission denied / IO error — leave the row alone so the
        # next sweep retries. Reaper logs + continues.
        {:error, {:fs, reason}}
    end
  end

  defp soft_delete(%Upload{} = up, now) do
    case Uploads.soft_delete(up, now) do
      {:ok, _} -> :ok
      {:error, %Ecto.Changeset{} = cs} -> {:error, cs}
    end
  end

  defp subject_kind(%Upload{user_id: id}) when is_binary(id), do: :user
  defp subject_kind(%Upload{visitor_id: id}) when is_binary(id), do: :visitor

  defp subject_id(%Upload{user_id: id}) when is_binary(id), do: id
  defp subject_id(%Upload{visitor_id: id}) when is_binary(id), do: id

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    storage_root = Keyword.fetch!(opts, :storage_root)

    # mkdir_p is idempotent + cheap; one-shot at boot keeps the
    # filesystem ready for the first POST without a separate
    # bootstrap step. Failure is fatal (the Reaper can't function
    # without a writable storage dir; let the supervisor see it).
    :ok = File.mkdir_p!(storage_root)

    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval, storage_root: storage_root}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    {:ok, n} = sweep(state.storage_root, DateTime.utc_now())

    case n do
      0 ->
        :ok

      _ ->
        Logger.info("uploads reaper swept", affected: n)
        :ok = AdminEvents.record(AdminWire.uploads_swept(n))
    end

    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
