defmodule GrappaWeb.GrappaChannel do
  @moduledoc """
  Single channel module for all Grappa real-time topics.

  Behavior on join:
    1. Parse the topic via `Grappa.PubSub.Topic.parse/1`. Unknown
       shapes (including the Phase 1 `grappa:network:...` shape, which
       sub-task 2h removed) get `{:error, %{reason: "unknown topic"}}`.
    2. Cross-user authz: every Grappa topic is rooted in a user_name.
       If `socket.assigns.user_name` does not match the topic's
       embedded user, return `{:error, %{reason: "forbidden"}}`. This
       is the LOAD-BEARING check — `Phoenix.PubSub` topics are a
       global namespace, so without this any authn'd socket could
       subscribe to any other user's topic by string-typing it.
    3. Subscribe to the topic on `Grappa.PubSub` and accept the join.

  On `{:event, payload}` from PubSub, push it to the connected socket
  as an `"event"` push verbatim. The push payload shape is whatever
  the broadcaster sent — this module does NOT reshape events. The
  wire-shape contract lives at the broadcasting boundary
  (`Grappa.Session.Server` via `Grappa.Scrollback.Wire`).

  Accepted topic shapes (single source of truth in `Grappa.PubSub.Topic`):

    - `"grappa:user:{user}"`
    - `"grappa:user:{user}/network:{net}"`
    - `"grappa:user:{user}/network:{net}/channel:{chan}"`

  Phase 1 still hardcodes the socket's `user_name` as `"vjt"` in
  `UserSocket.connect/3`; a later Phase 2 sub-task switches it to a
  token-derived value and the authz check below starts rejecting
  cross-user joins for real.
  """
  use GrappaWeb, :channel

  alias Grappa.PubSub.Topic

  @impl Phoenix.Channel
  def join(topic, _, socket) do
    with {:ok, parsed} <- Topic.parse(topic),
         :ok <- authorize(parsed, socket) do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
      {:ok, socket}
    else
      :error -> {:error, %{reason: "unknown topic"}}
      {:error, :forbidden} -> {:error, %{reason: "forbidden"}}
    end
  end

  @impl Phoenix.Channel
  def handle_info({:event, payload}, socket) do
    push(socket, "event", payload)
    {:noreply, socket}
  end

  defp authorize(parsed, socket) do
    if Topic.user_of(parsed) == socket.assigns.user_name do
      :ok
    else
      {:error, :forbidden}
    end
  end
end
