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
    deps: [Grappa.Admission, Grappa.Networks, Grappa.PubSub],
    exports: [Wire]

  use GenServer

  alias Grappa.AdminEvents.Wire
  alias Grappa.{Admission, Networks}
  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic

  require Logger

  @snapshot_cap 200
  @telemetry_handler_id "grappa-admin-events"
  @telemetry_events [
    [:grappa, :admission, :circuit, :open],
    [:grappa, :admission, :circuit, :close],
    [:grappa, :admission, :capacity, :reject],
    [:grappa, :session, :lifecycle, :spawned],
    [:grappa, :session, :lifecycle, :terminated]
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
  def handle_cast(
        {:telemetry, [:grappa, :session, :lifecycle, lifecycle], _, metadata},
        state
      )
      when lifecycle in [:spawned, :terminated] do
    # Lifecycle events synthesize a `:cap_counts_changed` event by
    # consulting `Admission.live_counts_for_network/1` (post-transition
    # truth) + `Networks.get_network/1` (cap denominators) HERE in the
    # sink — Session.Server.init/1's no-DB-read contract (cluster 2 A2
    # cycle inversion) forbids the emitter from doing those lookups.
    #
    # On `:terminated` the Registry has NOT yet purged the dying pid (its
    # monitor fires after `terminate/2` returns), so the raw Registry
    # count includes self. Subtract one from the subject_kind that just
    # exited to surface the true post-transition projection.
    #
    # S7 of U-5 review: defensive guard on subject_kind at the sink
    # boundary. `Session.Server.emit_lifecycle/2` already constrains
    # to `:user | :visitor`, but a future subject variant would crash
    # the singleton GenServer and wipe the audit ring. Validate here
    # too.
    %{network_id: nid, subject_kind: sk} = metadata

    if is_integer(nid) and sk in [:user, :visitor] do
      :ok = broadcast_lifecycle(lifecycle, nid, sk)
    else
      Logger.warning("admin_events: dropped lifecycle event with unknown shape",
        kind: lifecycle,
        subject_kind: inspect(sk),
        network_id: inspect(nid)
      )
    end

    {:noreply, state}
  end

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

  # Synthesize + broadcast (NOT buffer) a `:cap_counts_changed` event
  # for the given lifecycle transition. State is intentionally not a
  # parameter — this path never mutates the audit ring (S6 of U-5
  # review).
  #
  # S2 of U-5 review: when `Networks.get_network/1` returns nil the
  # network row was deleted between the lifecycle event firing and
  # this lookup. Broadcasting `network_slug: nil, caps: nil` would
  # lie about the operative caps (cic renders `∞` which is wrong —
  # the cap was N>0 when the session ran). Skip the broadcast
  # entirely; the ghost network's rows are gone from the next
  # `/admin/networks` fetch anyway.
  @spec broadcast_lifecycle(:spawned | :terminated, integer(), :user | :visitor) :: :ok
  defp broadcast_lifecycle(lifecycle, network_id, subject_kind) do
    case Networks.get_network(network_id) do
      nil ->
        :ok

      net ->
        raw = Admission.live_counts_for_network(network_id)
        counts = if lifecycle == :terminated, do: drop_self(raw, subject_kind), else: raw

        event =
          Wire.cap_counts_changed(
            network_id,
            net.slug,
            counts,
            net.max_concurrent_visitor_sessions,
            net.max_concurrent_user_sessions
          )

        broadcast_only(event)
    end
  end

  defp drop_self(%{visitors: v} = m, :visitor), do: %{m | visitors: max(v - 1, 0)}
  defp drop_self(%{users: u} = m, :user), do: %{m | users: max(u - 1, 0)}

  @spec broadcast_only(Wire.event()) :: :ok
  defp broadcast_only(event) do
    case GrappaPubSub.broadcast_event(Topic.admin_events(), event) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("admin_events broadcast failed",
          topic: Topic.admin_events(),
          kind: event.kind,
          reason: inspect(reason)
        )

        :ok
    end
  end

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
