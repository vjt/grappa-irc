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
  hooks) at the connect boundary AND `:current_subject` — the bare-id
  `Grappa.Subject.t()` tuple (`{:user, uuid}` or `{:visitor, uuid}`)
  consumed directly by channel arms that hit subject-scoped contexts
  (UserSettings, ReadCursor, QueryWindows, Push). Mirror of the
  controller-side `Subject.from_assigns/1` lift — V4 visitor-parity
  (2026-05-15).

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

  require Logger

  channel "grappa:user:*", GrappaWeb.GrappaChannel
  channel "grappa:admin:events", GrappaWeb.AdminChannel

  @impl Phoenix.Socket
  def connect(%{"token" => token}, socket, _) when is_binary(token) do
    with {:ok, session} <- Accounts.authenticate(token),
         {:ok, socket} <- assign_subject(socket, session) do
      socket = assign(socket, :current_session_id, session.id)
      # S3.1 + CP24 bucket E web/S5: register every WS pid (user AND
      # visitor) with WSPresence. The transport process (self() at
      # connect time) is the pid that owns the WS connection; when it
      # exits, the WS is gone.
      #
      # Two consumers care:
      #   * Auto-away (user-only): user `Session.Server` subscribes to
      #     `Topic.ws_presence/1` and debounces auto-away on
      #     `:ws_all_disconnected`. Visitor `Session.Server` does NOT
      #     subscribe (see `Session.Server.init/1`'s `match?({:user, _},
      #     opts.subject)` guard) so the registration is a harmless
      #     no-op on the auto-away path for visitors.
      #   * cic-bundle-changed broadcast (user + visitor): the admin
      #     endpoint iterates `WSPresence.list_user_names/0` to fan out
      #     the new bundle hash on every connected user-topic. Pre-fix
      #     visitor sockets were skipped at register-time so visitors
      #     with long-lived tabs never saw the refresh banner trigger.
      :ok = WSPresence.register(socket.assigns.user_name, self())

      {:ok, socket}
    else
      _ -> :error
    end
  end

  def connect(_, _, _), do: :error

  @impl Phoenix.Socket
  def id(socket), do: id_for_user_name(socket.assigns.user_name)

  @doc """
  W6: socket-id helper. Single source of truth for the topic shape
  Phoenix uses to drive `Endpoint.broadcast(socket_id, "disconnect", _)`
  — the broadcast site (`AuthController.maybe_disconnect_socket/1`)
  goes through this helper so a future change to the id shape
  automatically propagates to disconnect.

  Subject inference:

    * `{:user, %Accounts.User{name: name}}` → `"user_socket:" <> name`
    * `{:visitor, %Visitor{id: id}}` →
      `"user_socket:visitor:" <> id`

  Both shapes match the `user_name` assignment that `assign_subject/2`
  installs on the socket at connect time. Symmetric with the
  `id/1` callback above so the runtime topic Phoenix subscribes the
  transport process to is the topic the disconnect publishes on.
  """
  @spec id_for_subject(GrappaWeb.Subject.t()) :: String.t()
  def id_for_subject({:user, %Accounts.User{name: name}}) when is_binary(name),
    do: id_for_user_name(name)

  def id_for_subject({:visitor, %Visitor{id: id}}) when is_binary(id),
    do: id_for_user_name("visitor:" <> id)

  @doc """
  Close the live WebSocket for `subject` by broadcasting `"disconnect"`
  to its id-topic (the topic the transport process subscribes to at
  connect time). Phoenix's socket `__info__` catch-all maps the event to
  `{:stop, {:shutdown, :disconnected}, _}`, terminating the transport.

  Shared by `AuthController.logout/2` (#126 detach) and
  `MeController.delete/2` (#157 account wipe) — bearer revocation /
  account deletion is mid-flight enforcement, not just connect-time:
  without this push a logged-out / deleted browser keeps receiving PubSub
  fan-out until its next message is rejected.

  Fire-and-forget: a PubSub-server-unreachable `{:error, _}` is logged and
  swallowed (the caller has already revoked / deleted the session row, so
  the WS is rejected on its next message anyway) — never blocks the
  teardown response.
  """
  @spec disconnect_subject(GrappaWeb.Subject.t()) :: :ok
  def disconnect_subject(subject) do
    socket_id = id_for_subject(subject)

    case GrappaWeb.Endpoint.broadcast(socket_id, "disconnect", %{}) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("socket disconnect broadcast failed",
          socket_id: socket_id,
          reason: inspect(reason)
        )

        :ok
    end
  end

  @spec id_for_user_name(String.t()) :: String.t()
  defp id_for_user_name(user_name) when is_binary(user_name),
    do: "user_socket:" <> user_name

  defp assign_subject(socket, %Session{user_id: user_id, visitor_id: nil})
       when is_binary(user_id) do
    # FK guarantees the user row exists (ON DELETE CASCADE);
    # `Ecto.NoResultsError` here would be an invariant violation
    # worth crashing on.
    user = Accounts.get_user!(user_id)

    socket =
      socket
      |> assign(:user_name, user.name)
      |> assign(:current_subject, {:user, user.id})
      # M-11: surface the `is_admin` bit at the socket boundary so
      # `GrappaWeb.AdminChannel.authorize/1` can gate on it without
      # widening `current_subject` away from the bare-id tuple
      # contract (V4 visitor-parity: `Grappa.Subject.t()` is
      # `{:user, uuid} | {:visitor, uuid}`, NOT `{:user, %User{}}`).
      # Reading the bit here keeps the WS authz a constant-time
      # assigns check — no per-join Repo lookup.
      |> assign(:is_admin, user.is_admin)

    {:ok, socket}
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
          |> assign(:current_subject, {:visitor, visitor.id})
          # M-11: visitors are NEVER admins by construction
          # (`is_admin` lives on `User` only); set the assign
          # explicitly so AdminChannel can pattern-match on a
          # single shape across both subject kinds.
          |> assign(:is_admin, false)

        {:ok, socket}

      {:error, _} ->
        # `:expired` (W9 sliding TTL elapsed) and `:not_found`
        # (FK CASCADE invariant violation) both reject the connect —
        # uniform failure surface mirrors `Plugs.Authn` (Task 11).
        :error
    end
  end
end
