defmodule GrappaWeb.GrappaChannel do
  @moduledoc """
  Single channel module for all Grappa real-time topics.

  Behavior is uniform: on join, validate the topic shape via
  `Grappa.PubSub.Topic.parse/1` and subscribe to the same topic on
  `Grappa.PubSub`; on `{:event, payload}` from PubSub, push it to the
  connected socket as an `"event"` push verbatim.

  Accepted topic shapes (single source of truth in `Grappa.PubSub.Topic`):

    - `"grappa:user:{user}"`
    - `"grappa:network:{net}"`
    - `"grappa:network:{net}/channel:{chan}"`

  Any other shape returns `{:error, %{reason: "unknown topic"}}`.
  Topic discrimination lives in `Grappa.PubSub.Topic`; this module is
  just the Phoenix-side glue.

  The push payload shape is whatever the broadcaster sent — this
  module does NOT reshape events. The wire-shape contract lives at
  the broadcasting boundary (`MessagesController.create/2` +
  `Grappa.Session.Server`).

  Phase 2 will reject when a `:user` topic's user_name does not match
  `socket.assigns.user_name` once `connect/3` validates a token rather
  than hardcoding `"vjt"`.
  """
  use GrappaWeb, :channel

  alias Grappa.PubSub.Topic

  @impl Phoenix.Channel
  def join(topic, _, socket) do
    case Topic.parse(topic) do
      {:ok, _} ->
        :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
        {:ok, socket}

      :error ->
        {:error, %{reason: "unknown topic"}}
    end
  end

  @impl Phoenix.Channel
  def handle_info({:event, payload}, socket) do
    push(socket, "event", payload)
    {:noreply, socket}
  end
end
