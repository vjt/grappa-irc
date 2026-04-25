defmodule GrappaWeb.UserSocket do
  @moduledoc """
  WebSocket entry point at `/socket/websocket`.

  All Grappa channel topics (`grappa:user:*`, `grappa:network:*`)
  route to `GrappaWeb.GrappaChannel` — there is one channel module
  because join semantics differ only in topic shape, not in
  behavior. The channel does the topic discrimination.

  Phase 1 hardcodes the connecting user as `"vjt"`. Phase 2 will
  validate a token in `connect/3` and assign the resolved user from
  it; cross-user authorization on join is also Phase 2 scope (until
  there is more than one user, the check is moot).
  """
  use Phoenix.Socket

  channel "grappa:user:*", GrappaWeb.GrappaChannel
  channel "grappa:network:*", GrappaWeb.GrappaChannel

  @impl Phoenix.Socket
  def connect(_, socket, _) do
    {:ok, assign(socket, :user_name, "vjt")}
  end

  @impl Phoenix.Socket
  def id(socket), do: "user_socket:#{socket.assigns.user_name}"
end
