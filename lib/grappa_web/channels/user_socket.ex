defmodule GrappaWeb.UserSocket do
  @moduledoc """
  WebSocket entry point at `/socket/websocket`.

  Sub-task 2h roots every Grappa topic in the user discriminator
  (`grappa:user:{name}/...`); the legacy Phase 1 `grappa:network:*`
  route is gone — any client subscribing on that prefix would not
  resolve to a channel module and Phoenix returns the standard
  unknown-topic error. `grappa:user:*` is the only routed prefix
  because join semantics differ only in topic shape, not in behavior;
  `GrappaWeb.GrappaChannel` does the topic discrimination + per-subject
  authz on join.

  ## Connect-time auth (sub-task 2i + visitor-auth Task 12)

  `connect/3` verifies a bearer token in `params["token"]` against
  `Grappa.Accounts.authenticate/1` — same UUID PK that the REST
  surface consumes via `Authorization: Bearer ...`. The returned
  `Session` row carries an XOR FK (`user_id` xor `visitor_id`, per
  Q-A). `connect/3` dispatches on that XOR:

    * **User session** — assigns `:user_name = user.name` (from the
      User row).
    * **Visitor session** — assigns
      `:user_name = "visitor:" <> visitor.id` mirroring
      `Visitors.SessionPlan.build/1`'s `subject_label` rule (Q1=a)
      so `Session.Server`'s broadcasts under
      `Topic.channel("visitor:" <> visitor.id, ...)` route to the
      same value the channel-side authz check uses. Also assigns
      `:current_visitor_id` and `:current_visitor` for downstream
      channel handlers. The branch runs `Visitors.touch/1` for the
      W9 sliding-TTL refresh — visitor activity over the WS surface
      counts as user-initiated traffic, same as Plugs.Authn for REST.

  Both branches assign `:current_session_id` (for future revocation
  hooks) at the connect boundary.

  Any failure (missing param, malformed UUID, unknown row, revoked,
  expired user session, expired or vanished visitor) returns `:error`
  — Phoenix surfaces the WS rejection with no body; distinct error
  strings would just leak enumeration info on what went wrong with
  the token.
  """
  use Phoenix.Socket

  alias Grappa.{Accounts, Visitors, WSPresence}
  alias Grappa.Accounts.Session
  alias Grappa.Visitors.Visitor

  channel "grappa:user:*", GrappaWeb.GrappaChannel

  @impl Phoenix.Socket
  def connect(%{"token" => token}, socket, _) when is_binary(token) do
    with {:ok, session} <- Accounts.authenticate(token),
         {:ok, socket} <- assign_subject(socket, session) do
      socket = assign(socket, :current_session_id, session.id)
      # S3.1: register socket pid with WSPresence so the auto-away
      # debounce fires when all WS connections for this user close.
      # Visitor sessions skip this — visitor disconnect = bouncer disconnect
      # (ephemeral credential); no upstream session to mark away.
      user_name = socket.assigns.user_name

      unless String.starts_with?(user_name, "visitor:") do
        # The transport process (self() at connect time) is the pid that owns
        # the WS connection. When it exits, the WS is gone. We monitor it via
        # WSPresence so auto-away fires when all connections for this user close.
        :ok = WSPresence.register(user_name, self())
      end

      {:ok, socket}
    else
      _ -> :error
    end
  end

  def connect(_, _, _), do: :error

  @impl Phoenix.Socket
  def id(socket), do: "user_socket:#{socket.assigns.user_name}"

  defp assign_subject(socket, %Session{user_id: user_id, visitor_id: nil})
       when is_binary(user_id) do
    # FK guarantees the user row exists (ON DELETE CASCADE);
    # `Ecto.NoResultsError` here would be an invariant violation
    # worth crashing on.
    user = Accounts.get_user!(user_id)
    {:ok, assign(socket, :user_name, user.name)}
  end

  defp assign_subject(socket, %Session{user_id: nil, visitor_id: visitor_id})
       when is_binary(visitor_id) do
    case Visitors.touch(visitor_id) do
      {:ok, %Visitor{} = visitor} ->
        socket =
          socket
          |> assign(:user_name, "visitor:" <> visitor.id)
          |> assign(:current_visitor_id, visitor.id)
          |> assign(:current_visitor, visitor)

        {:ok, socket}

      {:error, _} ->
        # `:expired` (W9 sliding TTL elapsed) and `:not_found`
        # (FK CASCADE invariant violation) both reject the connect —
        # uniform failure surface mirrors `Plugs.Authn` (Task 11).
        :error
    end
  end
end
