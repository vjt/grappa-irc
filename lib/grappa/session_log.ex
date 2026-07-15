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

    2. **Persist + expose** (added by the GenServer sink + Ecto schema in a
       follow-up commit) — a sink attaches to the telemetry events, writes
       each to `session_log_events`, prunes to a bounded ring, and
       broadcasts on `Grappa.PubSub.Topic.session_log/0`. The admin REST /
       channel doors + cic tab read from there.

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

  use Boundary, top_level?: true, deps: []

  require Logger

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
