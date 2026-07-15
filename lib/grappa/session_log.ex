defmodule Grappa.SessionLog do
  @moduledoc """
  Structured IRC session-lifecycle log (#215).

  Two responsibilities, one context:

    1. **Emit** (this file, stateless) — `emit/3` is the SINGLE emit path
       every `Grappa.Session.Server` lifecycle transition routes through.
       It does TWO things, synchronously, in the caller's process:

         * writes a human-readable, greppable Logger line with structured
           KV metadata (`session=user:<uuid>:<nid> event=disconnected
           reason=:tcp_closed …`) — this is the "1995-style, greppable at
           2am" log the issue asked for, and it fires reliably even at BEAM
           shutdown (no async hop);
         * fires a `[:grappa, :session, :log, <event>]` telemetry event
           carrying the full structured metadata map.

    2. **Persist + expose** (the GenServer sink below) — `init/1` attaches
       to the `[:grappa, :session, :log, _]` telemetry events; the handler
       casts each to the sink, which writes it to `session_log_events`,
       prunes to a bounded on-disk ring (newest `retention` rows), and
       broadcasts the wire event on `Grappa.PubSub.Topic.session_log/0`.
       `list/1` is the newest-first tail read the admin REST / channel
       doors + cic tab consume.

  ## Restart / test isolation

  `:permanent` singleton (registered as `__MODULE__`). Boots with
  `attach_telemetry: false` in test env (`config :grappa,
  :attach_session_log_telemetry, false`) — otherwise the global handler
  would route EVERY async test's lifecycle telemetry to this pid, whose
  Repo write would hit a sandbox connection owned by the emitting test.
  Persistence tests attach + `Sandbox.allow/3` explicitly (mirror of
  `Grappa.AdminEvents`). Tests touching this module MUST be `async:
  false` (max_cases: 1 invariant).

  The emit path is deliberately telemetry-decoupled from the sink: a
  disconnect fired from `Session.Server.terminate/2` must never block on a
  DB write. The Logger line is the reliable record; the persisted row is
  best-effort (the sink owns its own process + failure logging).

  ## session-id

  `session_id/2` is the stable composite `"<kind>:<uuid>:<network_id>"`
  (e.g. `"user:3f…:42"`, `"visitor:9a…:7"`) — the same `(subject,
  network_id)` pair the `Grappa.SessionRegistry` key is built from, in a
  greppable string form. NOT the auth bearer session-id (that is a secret;
  see `Grappa.Log` `session_ref`).
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo, Grappa.PubSub], exports: [Event, Wire]

  use GenServer

  import Ecto.Query

  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic
  alias Grappa.Repo
  alias Grappa.SessionLog.{Event, Wire}

  require Logger

  # Genuine config default (correct production behavior): the on-disk ring
  # cap. Session-lifecycle events are LOW frequency (per connect/disconnect,
  # not per message), so 5000 rows is a long history. `:retention`
  # start_link opt overrides (tests shrink it to exercise pruning).
  @default_retention Application.compile_env(:grappa, [:session_log, :retention], 5000)

  @telemetry_handler_id "grappa-session-log"
  @telemetry_events [
    [:grappa, :session, :log, :connected],
    [:grappa, :session, :log, :registered],
    [:grappa, :session, :log, :identified],
    [:grappa, :session, :log, :deidentified],
    [:grappa, :session, :log, :disconnected],
    [:grappa, :session, :log, :backoff]
  ]

  defstruct retention: @default_retention

  @type t :: %__MODULE__{retention: pos_integer()}

  @typedoc "Closed set of session-lifecycle events (#215)."
  @type event ::
          :connected
          | :registered
          | :identified
          | :deidentified
          | :disconnected
          | :backoff

  @typedoc "The `(subject, network_id)` identity a session log entry is keyed on."
  @type subject :: {:user | :visitor, String.t()}

  @doc """
  Builds the stable composite session-id `"<kind>:<uuid>:<network_id>"`.
  """
  @spec session_id(subject(), integer()) :: String.t()
  def session_id({kind, uuid}, network_id)
      when kind in [:user, :visitor] and is_binary(uuid) and is_integer(network_id) do
    "#{kind}:#{uuid}:#{network_id}"
  end

  @doc """
  The single session-lifecycle emit path: one Logger line + one
  `[:grappa, :session, :log, event]` telemetry event, both carrying the
  structured metadata the persistence sink consumes.

  `fields` is the `Session.Server` state (or any map exposing `:subject`,
  `:network_id`, `:network_slug`, `:nick`). `extra` carries the
  event-specific keys:

    * `:disconnected` → `reason` (string), `clean` (boolean),
      `duration_ms` (integer)
    * `:backoff` → `delay_ms` (integer), `attempt` (integer)

  No default arguments — every caller passes `extra` explicitly (`[]` when
  the event has no extras).
  """
  @spec emit(
          event(),
          %{
            :subject => subject(),
            :network_id => integer(),
            :network_slug => String.t(),
            :nick => String.t(),
            optional(any()) => any()
          },
          keyword()
        ) :: :ok
  def emit(event, %{subject: {kind, _} = subject, network_id: nid, network_slug: slug, nick: nick}, extra)
      when event in [:connected, :registered, :identified, :deidentified, :disconnected, :backoff] and
             is_list(extra) do
    metadata = %{
      session_id: session_id(subject, nid),
      event: event,
      subject_kind: kind,
      network_id: nid,
      network_slug: slug,
      nick: nick,
      reason: Keyword.get(extra, :reason),
      clean: Keyword.get(extra, :clean),
      duration_ms: Keyword.get(extra, :duration_ms),
      delay_ms: Keyword.get(extra, :delay_ms),
      attempt: Keyword.get(extra, :attempt),
      at: DateTime.utc_now()
    }

    log(event, metadata)
    :telemetry.execute([:grappa, :session, :log, event], %{}, metadata)
    :ok
  end

  # ----- Sink (GenServer) + read API -----------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Returns the newest-first tail of persisted session-lifecycle events,
  bounded to `limit`. Reads the DB directly (the store is on disk, not
  GenServer state) — no sink round-trip.
  """
  @spec list(pos_integer()) :: [Event.t()]
  def list(limit) when is_integer(limit) and limit > 0 do
    Repo.all(from(e in Event, order_by: [desc: e.id], limit: ^limit))
  end

  @impl GenServer
  def init(opts) do
    if Keyword.get(opts, :attach_telemetry, true) do
      # Detach-then-attach: a brutal_kill restart skips terminate/2 and
      # would leave a stale handler bound to a dead pid (mirror of
      # AdminEvents). Detach on an unknown id is :ok.
      _ = :telemetry.detach(@telemetry_handler_id)

      :ok =
        :telemetry.attach_many(
          @telemetry_handler_id,
          @telemetry_events,
          &__MODULE__.handle_telemetry/4,
          nil
        )
    end

    {:ok, %__MODULE__{retention: Keyword.get(opts, :retention, @default_retention)}}
  end

  @doc false
  # Runs in the EMITTER's process (Session.Server) per :telemetry semantics
  # — keep it a bare cast so the emit hot path (incl. terminate/2) never
  # blocks on the DB write. The full structured map rides in `metadata`.
  @spec handle_telemetry([atom()], map(), map(), term()) :: :ok
  def handle_telemetry(_event_name, _measurements, metadata, _) do
    GenServer.cast(__MODULE__, {:persist, metadata})
  end

  @impl GenServer
  def handle_cast({:persist, metadata}, state) do
    case persist(metadata) do
      {:ok, event} ->
        broadcast(event)

      {:error, changeset} ->
        # Best-effort persist — the Logger line (emit/3) is the reliable
        # record. Log honestly (no silent drop) and keep the sink alive.
        Logger.error("session_log persist failed",
          event: metadata[:event],
          reason: inspect(changeset)
        )
    end

    prune(state.retention)
    {:noreply, state}
  end

  @impl GenServer
  def terminate(_, _) do
    :ok = :telemetry.detach(@telemetry_handler_id)
  end

  @spec persist(map()) :: {:ok, Event.t()} | {:error, Ecto.Changeset.t()}
  defp persist(metadata) do
    %Event{} |> Event.changeset(metadata) |> Repo.insert()
  end

  @spec broadcast(Event.t()) :: :ok
  defp broadcast(event) do
    case GrappaPubSub.broadcast_event(Topic.session_log(), Wire.entry_payload(event)) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("session_log broadcast failed",
          topic: Topic.session_log(),
          reason: inspect(reason)
        )

        :ok
    end
  end

  # On-disk ring: delete every row older than the `retention`-th newest.
  # id (PK autoincrement) is the insertion order — an indexed range delete.
  @spec prune(pos_integer()) :: :ok
  defp prune(retention) do
    cutoff =
      Repo.one(from(e in Event, order_by: [desc: e.id], offset: ^(retention - 1), limit: 1, select: e.id))

    case cutoff do
      nil -> :ok
      id -> Repo.delete_all(from(e in Event, where: e.id < ^id))
    end

    :ok
  end

  # ----- Human-readable Logger lines -----------------------------------

  # Only allowlisted metadata keys (config/config.exs) survive the console
  # formatter — session_id/event/duration_ms/clean were added there for
  # #215; nick/reason/delay_ms/failure_count pre-exist.
  defp log(:disconnected, md) do
    level = if md.clean, do: :info, else: :warning

    Logger.log(level, "session disconnected",
      session_id: md.session_id,
      event: md.event,
      nick: md.nick,
      reason: md.reason,
      duration_ms: md.duration_ms,
      clean: md.clean
    )
  end

  defp log(:backoff, md) do
    Logger.info("session reconnect backoff",
      session_id: md.session_id,
      event: md.event,
      delay_ms: md.delay_ms,
      failure_count: md.attempt
    )
  end

  defp log(:deidentified, md) do
    Logger.warning("session lost identification (-r)",
      session_id: md.session_id,
      event: md.event,
      nick: md.nick
    )
  end

  defp log(event, md) when event in [:connected, :registered, :identified] do
    Logger.info("session #{event}",
      session_id: md.session_id,
      event: md.event,
      nick: md.nick
    )
  end
end
