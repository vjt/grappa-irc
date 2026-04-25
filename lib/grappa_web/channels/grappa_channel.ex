defmodule GrappaWeb.GrappaChannel do
  @moduledoc """
  Single channel module for all Grappa real-time topics.

  Behavior is uniform: on join, validate the topic shape and
  subscribe to the same topic on `Grappa.PubSub`; on `{:event,
  payload}` from PubSub, push it to the connected socket as an
  `"event"` push verbatim.

  Accepted topic shapes:

    - `"grappa:user:{user}"`
    - `"grappa:network:{net}"`
    - `"grappa:network:{net}/channel:{chan}"`

  Any other shape returns `{:error, %{reason: "unknown topic"}}`.
  Topic discrimination lives here (not the socket router) so the
  set of valid topics is one grep away.

  The push payload shape is whatever the broadcaster sent — this
  module does NOT reshape events. The wire-shape contract lives at
  the broadcasting boundary (`MessagesController.create/2` today).
  """
  use GrappaWeb, :channel

  @impl Phoenix.Channel
  def join("grappa:user:" <> user, _, socket) when user != "" do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, socket.topic)
    {:ok, socket}
  end

  def join("grappa:network:" <> rest = topic, _, socket) do
    if valid_network_topic?(rest) do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
      {:ok, socket}
    else
      {:error, %{reason: "unknown topic"}}
    end
  end

  def join(_, _, _), do: {:error, %{reason: "unknown topic"}}

  @impl Phoenix.Channel
  def handle_info({:event, payload}, socket) do
    push(socket, "event", payload)
    {:noreply, socket}
  end

  @spec valid_network_topic?(String.t()) :: boolean()
  defp valid_network_topic?(rest) do
    case String.split(rest, "/", parts: 2) do
      [net] when net != "" -> true
      [net, "channel:" <> chan] when net != "" and chan != "" -> true
      _ -> false
    end
  end
end
