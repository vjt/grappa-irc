defmodule GrappaWeb.UserSocket do
  @moduledoc """
  WebSocket entry point at `/socket/websocket`.

  Sub-task 2h roots every Grappa topic in the user discriminator
  (`grappa:user:{name}/...`); the legacy Phase 1 `grappa:network:*`
  route is gone — any client subscribing on that prefix would not
  resolve to a channel module and Phoenix returns the standard
  unknown-topic error. `grappa:user:*` is the only routed prefix
  because join semantics differ only in topic shape, not in behavior;
  `GrappaWeb.GrappaChannel` does the topic discrimination + per-user
  authz on join.

  Phase 1 hardcodes the connecting user as `"vjt"`. A later Phase 2
  sub-task validates a token in `connect/3` and assigns the resolved
  user from it; until then, the authz check on join is a no-op for
  the hardcoded "vjt" socket but is wired so the moment connect/3
  starts assigning a real user_name, cross-user subscribes get
  rejected with no extra change.
  """
  use Phoenix.Socket

  channel "grappa:user:*", GrappaWeb.GrappaChannel

  @impl Phoenix.Socket
  def connect(_, socket, _) do
    {:ok, assign(socket, :user_name, "vjt")}
  end

  @impl Phoenix.Socket
  def id(socket), do: "user_socket:#{socket.assigns.user_name}"
end
