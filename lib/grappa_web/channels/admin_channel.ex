defmodule GrappaWeb.AdminChannel do
  @moduledoc """
  Phoenix Channel for `Grappa.PubSub.Topic.admin_events/0` —
  `"grappa:admin:events"` (M-cluster M-11).

  ## Authz

  Single shape passes: `socket.assigns.is_admin == true`. This is the
  WS sibling of `GrappaWeb.Admin.AuthPlug`'s `is_admin` gate on
  `conn.assigns.current_subject`. The two surfaces share one invariant
  ("admin = `is_admin: true` on the User row"); the shape difference
  is just the carrier (struct on HTTP, bare-id tuple + sibling assign
  on WS — see `UserSocket.assign_subject/2` rationale for keeping the
  `current_subject` tuple bare-id per V4 visitor-parity).

  Visitor subjects + non-admin user subjects + missing `is_admin`
  assign collapse to `{:error, %{error: "forbidden"}}`.

  ## Snapshot on join

  After-join push delivers the in-memory ring buffer (newest-first)
  as a `"snapshot"` event via `push/3`. Mirror of
  `GrappaChannel.push_user_snapshot/2` — cold-WS-subscribe parity so
  the Events tab populates immediately on first open (no flicker).

  ## Session-lifecycle log live push (#215)

  On join the channel ALSO subscribes to `Topic.session_log/0`
  (`"grappa:session_log"`) — a DIFFERENT topic from the channel's own
  joined topic, so the sink's `%Phoenix.Socket.Broadcast{}` arrives via
  `handle_info/2` (not the fastlane) and is re-pushed as a
  `"session_log_event"`. The snapshot for this surface is the REST door
  (`GET /admin/session_log`), which cic fetches on tab mount; the channel
  carries only live updates. Reuses the admin socket rather than a second
  channel (Option B: two persisted admin surfaces, one operator socket).

  ## Nothing unknown is fatal, in either direction (#1407 W-S7)

  Neither an unrecognised inbound frame nor an unrecognised mailbox
  message takes the operator's console down: both collapse to a
  catch-all, and the `handle_info/2` one logs at warning so the message
  it cannot read stays visible. See that clause for why crashing would
  surface less, not more.

  ## No inbound handlers

  Admin events are server-originated only. The single `handle_in/3`
  clause below pattern-matches everything and replies `:ok` so the
  framework doesn't crash on an unexpected client push. A future
  operator action driven from the admin tab (e.g. "clear events
  buffer") would land as a controller endpoint, not a channel
  inbound — admin REST is the existing mutation surface.

  ## Test isolation

  Tests touching this channel MUST be `async: false` because
  `Grappa.AdminEvents` is a singleton (registered as `__MODULE__`).
  Channel-level tests subscribe to `Topic.admin_events/0` directly
  for assertions; AdminEvents itself runs once for the whole suite.
  """
  use GrappaWeb, :channel

  alias Grappa.{AdminEvents, AdminOverview}
  alias Grappa.PubSub.Topic

  require Logger

  @impl Phoenix.Channel
  def join("grappa:admin:events", _, socket) do
    case authorize(socket) do
      :ok ->
        # #215 — receive session-lifecycle-log events on this admin
        # socket. Foreign topic (not the channel's joined one), so the
        # broadcast lands in handle_info/2, not the fastlane.
        :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.session_log())
        Process.send_after(self(), :after_join, 0)
        {:ok, socket}

      {:error, :forbidden} ->
        {:error, %{error: "forbidden"}}
    end
  end

  def join(_, _, _), do: {:error, %{error: "unknown_topic"}}

  @impl Phoenix.Channel
  def handle_info(:after_join, socket) do
    push(socket, "snapshot", %{events: AdminEvents.snapshot()})
    push_overview(socket)
    {:noreply, socket}
  end

  # #1075 — the admin top bar's cadence. See `push_overview/1`.
  def handle_info(:overview_tick, socket) do
    push_overview(socket)
    {:noreply, socket}
  end

  # #215 — session-lifecycle-log event from the SessionLog sink's
  # broadcast on Topic.session_log/0. Re-push to the admin socket.
  def handle_info(
        %Phoenix.Socket.Broadcast{topic: "grappa:session_log", event: "event", payload: payload},
        socket
      ) do
    push(socket, "session_log_event", payload)
    {:noreply, socket}
  end

  # W-S7 (#1407) — the info-side twin of the inbound catch-all below, and
  # the third instance of the #1338 `unknown-is-never-fatal` family: same
  # logged shape as `GrappaWeb.SessionRevocationListener` and
  # `Grappa.IRC.Client`, chosen over inventing a second one.
  #
  # The three clauses above are exhaustive only by luck — one hardcoded
  # event name (`PubSub.broadcast_event/2`) from the one publisher on
  # `Topic.session_log/0`. A second publisher, a renamed event, or any
  # stray `send/2` would otherwise kill the console with a
  # `FunctionClauseError`, which is the exact outcome the `handle_in/3`
  # catch-all below refuses to allow — this module argued one posture and
  # implemented the other.
  #
  # Not a funnel: the message is logged at warning under the allowlisted
  # `unexpected:` key, so what this channel cannot read is visible in the
  # operator's own log rather than swallowed. Crashing would surface it
  # too, but strictly worse: the push this channel performs is
  # per-MESSAGE and stateless, so a crash cannot retry the unread message
  # — it only discards the mailbox behind it, taking live session-log
  # events down with it, and a repeating publisher then walks the restart
  # intensity until the operator's console is gone for good.
  def handle_info(msg, socket) do
    Logger.warning("unexpected mailbox message", unexpected: inspect(msg))
    {:noreply, socket}
  end

  # Catch-all for any client-sent inbound event. Admin events are
  # server-originated only; without this clause Phoenix's default
  # `handle_in/3` raises `UndefinedFunctionError`, crashing the
  # channel pid. Reply `:ok` so a hostile or buggy cic can't take
  # down the admin socket.
  @impl Phoenix.Channel
  def handle_in(_, _, socket), do: {:reply, :ok, socket}

  # #1075 — push the admin-bar projection, then arm the next tick.
  #
  # The counts could ride `Topic.admin_events/0` (they change because
  # something happened), but loadavg cannot: it is a sampled quantity with
  # no event to hang off. Rather than run an event path AND a sampler, one
  # tick carries all five stats.
  #
  # The timer lives in THIS process, not in a supervised singleton: the bar
  # only exists while an operator has the console open, so the sampling
  # should too — it starts on join and dies with the socket, with no
  # cross-console fan-out to manage. The interval is re-read per tick, so a
  # hot-deployed change lands on the next one.
  @spec push_overview(Phoenix.Socket.t()) :: :ok
  defp push_overview(socket) do
    push(socket, "overview", AdminOverview.snapshot())
    Process.send_after(self(), :overview_tick, AdminOverview.push_interval_ms())
    :ok
  end

  @spec authorize(Phoenix.Socket.t()) :: :ok | {:error, :forbidden}
  defp authorize(socket) do
    if admin_socket?(socket), do: :ok, else: {:error, :forbidden}
  end

  @doc """
  Whether `socket` speaks for a grappa admin with a full web session — the
  one predicate behind this channel's join and behind every other WS door
  that answers an admin differently (issue 2597: the client addresses a
  WHOIS bundle carries).
  """
  @spec admin_socket?(Phoenix.Socket.t()) :: boolean()
  # #1196 — admin-ness is necessary but no longer sufficient: a
  # per-client token minted by an admin is still a scoped credential, and
  # the operator console is the first surface it must not reach. The REST
  # side refuses via `GrappaWeb.Plugs.RequireFullSession`; this is the
  # same refusal on the door the console's live feed actually comes
  # through. Both conditions in ONE clause so neither can be satisfied
  # alone.
  def admin_socket?(%{assigns: %{is_admin: true, current_session_kind: :web}}), do: true
  def admin_socket?(_), do: false
end
