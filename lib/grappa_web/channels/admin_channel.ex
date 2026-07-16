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

  alias Grappa.AdminEvents
  alias Grappa.PubSub.Topic

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

  def join(_, _, _), do: {:error, %{error: "unknown topic"}}

  @impl Phoenix.Channel
  def handle_info(:after_join, socket) do
    push(socket, "snapshot", %{events: AdminEvents.snapshot()})
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

  # Catch-all for any client-sent inbound event. Admin events are
  # server-originated only; without this clause Phoenix's default
  # `handle_in/3` raises `UndefinedFunctionError`, crashing the
  # channel pid. Reply `:ok` so a hostile or buggy cic can't take
  # down the admin socket.
  @impl Phoenix.Channel
  def handle_in(_, _, socket), do: {:reply, :ok, socket}

  @spec authorize(Phoenix.Socket.t()) :: :ok | {:error, :forbidden}
  defp authorize(%{assigns: %{is_admin: true}}), do: :ok
  defp authorize(_), do: {:error, :forbidden}
end
