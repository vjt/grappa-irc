defmodule Grappa.AdminEvents do
  @moduledoc """
  Singleton GenServer that aggregates admin events for the operator
  console (M-cluster M-11).

  Two emission paths:

    1. **Telemetry adapter** — `init/1` attaches `:telemetry.attach_many/4`
       handlers for admission-layer events
       (`[:grappa, :admission, :circuit, :open | :close]`,
       `[:grappa, :admission, :capacity, :reject]`). The handler casts
       the triple to the GenServer mailbox; `handle_cast/2` translates
       to a typed wire shape via `Grappa.AdminEvents.Wire.from_telemetry/3`
       and broadcasts on `Grappa.PubSub.Topic.admin_events/0`.

    2. **Synthetic record path** — `record/1` accepts a pre-built
       `Wire.event()` (visitor delete, session disconnect/terminate,
       network caps update, reaper sweep, circuit reset) emitted from
       controller / operator code paths where actor attribution is in
       scope. Mirror of the telemetry path: same broadcast + ring
       buffer prepend.

  ## Ring buffer

  Holds the last `@snapshot_cap` events (newest-first) in GenServer
  state. Cap is intentionally small — the Events tab is a real-time
  signal, not an audit log. Audit lives in Logger; operators paging
  through historical events do so via log search. Cap of 200 covers
  ~3-5 minutes of operator activity at peak.

  `AdminChannel.join/3` calls `snapshot/0` and pushes the buffer to
  the joining socket via the `"snapshot"` event — same pattern as
  `GrappaChannel.push_user_snapshot/2` (cold-WS-subscribe parity).

  ## Restart strategy

  `:permanent` (infrastructure). Crashing forgets the in-memory ring
  buffer but the telemetry handler re-attaches on init/1; new events
  start populating immediately. Operators reopening the admin pane
  rejoin the channel and the snapshot push lands the post-crash state.

  ## Test isolation

  Singleton (registered as `__MODULE__`). Tests that touch this
  module MUST be `async: false` and respect the global `max_cases: 1`
  invariant (`config/test.exs`).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Grappa.PubSub],
    exports: [Wire]

  use GenServer

  alias Grappa.AdminEvents.Wire
  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic

  require Logger

  @snapshot_cap 200
  @telemetry_handler_id "grappa-admin-events"
  @telemetry_events [
    [:grappa, :admission, :circuit, :open],
    [:grappa, :admission, :circuit, :close],
    [:grappa, :admission, :capacity, :reject]
  ]

  defstruct buffer: []

  @type t :: %__MODULE__{buffer: [Wire.event()]}

  ## ----- Public API ---------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Records a synthetic admin event (controller/operator code path
  with actor in scope). Cast — fire-and-forget. The receiving
  GenServer broadcasts on `Topic.admin_events/0` and prepends to
  the ring buffer.

  `event` must be one of the typed shapes from
  `Grappa.AdminEvents.Wire`. A struct or untyped map raises at the
  PubSub layer via `Grappa.PubSub.broadcast_event/2`'s struct guard.
  """
  @spec record(Wire.event()) :: :ok
  def record(%{kind: _} = event), do: GenServer.cast(__MODULE__, {:record, event})

  @doc """
  Returns the in-memory ring buffer (newest-first). Bounded to
  `@snapshot_cap` events.
  """
  @spec snapshot() :: [Wire.event()]
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)

  ## ----- GenServer callbacks ------------------------------------------

  @impl GenServer
  def init(opts) do
    if Keyword.get(opts, :attach_telemetry, true) do
      # Detach-then-attach so a brutal_kill restart (terminate/2 never
      # runs) doesn't leave a stale handler attached to a dead pid.
      # `:telemetry.attach_many/4` returns `{:error, :already_exists}`
      # on duplicate id; the bare `:ok =` match would crash the restart
      # into a supervisor loop. `:telemetry.detach/1` on an unknown id
      # is `:ok`, so this is safe on first boot too.
      _ = :telemetry.detach(@telemetry_handler_id)

      :ok =
        :telemetry.attach_many(
          @telemetry_handler_id,
          @telemetry_events,
          &__MODULE__.handle_telemetry/4,
          nil
        )
    end

    {:ok, %__MODULE__{}}
  end

  @doc false
  # Telemetry callback runs in the EMITTER's process (per :telemetry
  # semantics). Push the translation off the emitter's hot path —
  # forward the raw triple onto the GenServer mailbox so the Wire
  # translation + broadcast happen in the serialized AdminEvents
  # process.
  @spec handle_telemetry([atom()], map(), map(), term()) :: :ok
  def handle_telemetry(event_name, measurements, metadata, _) do
    GenServer.cast(__MODULE__, {:telemetry, event_name, measurements, metadata})
  end

  @impl GenServer
  def handle_cast({:telemetry, event_name, measurements, metadata}, state) do
    case Wire.from_telemetry(event_name, measurements, metadata) do
      :skip -> {:noreply, state}
      event when is_map(event) -> {:noreply, broadcast_and_buffer(event, state)}
    end
  end

  def handle_cast({:record, event}, state) do
    {:noreply, broadcast_and_buffer(event, state)}
  end

  @impl GenServer
  def handle_call(:snapshot, _, state), do: {:reply, state.buffer, state}

  @impl GenServer
  def terminate(_, _) do
    # Detach so a re-init doesn't accumulate stale handlers — telemetry
    # warns on duplicate IDs. Safe to call when not attached (telemetry
    # returns :ok for unknown ids).
    :ok = :telemetry.detach(@telemetry_handler_id)
  end

  ## ----- Internals ----------------------------------------------------

  @spec broadcast_and_buffer(Wire.event(), t()) :: t()
  defp broadcast_and_buffer(event, state) do
    case GrappaPubSub.broadcast_event(Topic.admin_events(), event) do
      :ok ->
        :ok

      {:error, reason} ->
        # `broadcast_event/2` already emits the
        # `[:grappa, :pubsub, :broadcast_failed]` telemetry event;
        # log honestly so the operator sees the silent-drop class
        # land here too (no-silent-drops invariant).
        Logger.error("admin_events broadcast failed",
          topic: Topic.admin_events(),
          kind: event.kind,
          reason: inspect(reason)
        )
    end

    %{state | buffer: cap([event | state.buffer])}
  end

  @spec cap([Wire.event()]) :: [Wire.event()]
  defp cap(list) when length(list) > @snapshot_cap, do: Enum.take(list, @snapshot_cap)
  defp cap(list), do: list
end
