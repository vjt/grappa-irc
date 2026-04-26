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

  ## Connect-time auth (sub-task 2i)

  `connect/3` verifies a bearer token in `params["token"]` against
  `Grappa.Accounts.authenticate/1` — same UUID PK that the REST
  surface consumes via `Authorization: Bearer ...`. On success,
  `:user_name` (from the User row) and `:current_session_id` are
  assigned on the socket; the channel's join callback in
  `GrappaWeb.GrappaChannel` compares the topic's embedded user
  against `socket.assigns.user_name` so cross-user joins are
  rejected.

  Any failure (missing param, malformed UUID, unknown row, revoked,
  expired) returns `:error` — Phoenix surfaces the WS rejection
  with no body; distinct error strings would just leak enumeration
  info on what went wrong with the token.
  """
  use Phoenix.Socket

  alias Grappa.Accounts

  channel "grappa:user:*", GrappaWeb.GrappaChannel

  @impl Phoenix.Socket
  def connect(%{"token" => token}, socket, _) when is_binary(token) do
    case Accounts.authenticate(token) do
      {:ok, session} ->
        # FK guarantees the user row exists; a deleted user would
        # have already cascaded its sessions away. Ecto.NoResultsError
        # here would be an invariant violation worth crashing on.
        user = Accounts.get_user!(session.user_id)

        {:ok,
         socket
         |> assign(:user_name, user.name)
         |> assign(:current_session_id, session.id)}

      {:error, _} ->
        :error
    end
  end

  def connect(_, _, _), do: :error

  @impl Phoenix.Socket
  def id(socket), do: "user_socket:#{socket.assigns.user_name}"
end
