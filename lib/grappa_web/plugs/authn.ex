defmodule GrappaWeb.Plugs.Authn do
  @moduledoc """
  Bearer-token authn plug for the JSON REST surface.

  On a valid `Authorization: Bearer <uuid>` header backed by a live
  session, the plug branches on the session row's FK (per Q-A's XOR
  shape — `user_id` xor `visitor_id` always exactly one populated):

    * **User session** → assigns `:current_user_id`,
      `:current_user` (the loaded `%Accounts.User{}`), and
      `:current_session_id`.
    * **Visitor session** → assigns `:current_visitor_id`,
      `:current_visitor` (the loaded `%Visitors.Visitor{}`), and
      `:current_session_id`. The plug ALSO calls `Visitors.touch/1`
      for the W9 sliding-TTL refresh — visitor activity over the REST
      surface counts as user-initiated traffic. Cadence (≥1h) is
      handled inside `touch/1`.

  Both branches additionally assign `:current_client_id` — the
  validated `X-Grappa-Client-Id` header value (URL-safe ASCII, ≤64
  bytes), or `nil` if absent or malformed. Read by the admission gates
  and `AuthController` for per-client session tracking.

  Loading the subject here costs one DB round-trip per authenticated
  request but eliminates the `Accounts.get_user!/1` re-fetch each
  user-aware controller used to perform. The session FK is
  `ON DELETE CASCADE`, so a missing subject row is an invariant
  violation: `Accounts.get_user!/1` raises; the visitor branch returns
  `:visitor_missing` so the violation surfaces in the operator log
  rather than silently 401ing.

  On any failure (missing header, wrong scheme, malformed token,
  unknown / revoked / expired session, expired visitor, vanished
  subject row) the plug halts with a 401 JSON body — no leak of which
  failure mode triggered it (deliberate, mirrors the
  `get_user_by_credentials/2` oracle posture in `Grappa.Accounts`).

  Channels do their own auth in `UserSocket.connect/3` — this plug is
  HTTP-only.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.{Accounts, Visitors}
  alias Grappa.Accounts.Session
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.FallbackController

  require Logger

  @client_id_regex ~r/\A[A-Za-z0-9_-]+\z/

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    with {:ok, token} <- get_token(conn),
         {:ok, session} <- Accounts.authenticate(token),
         {:ok, conn} <- assign_subject(conn, session) do
      assign(conn, :current_session_id, session.id)
    else
      {:error, reason} ->
        # Reason stays in operator logs (greppable) but never reaches
        # the wire — the 401 body is uniform on purpose so the plug
        # doesn't leak token-state to a probing attacker.
        Logger.info("authn rejected", authn_failure: reason)
        unauthorized(conn)

      :error ->
        Logger.info("authn rejected", authn_failure: :no_bearer)
        unauthorized(conn)
    end
  end

  defp assign_subject(conn, %Session{user_id: user_id, visitor_id: nil})
       when is_binary(user_id) do
    user = Accounts.get_user!(user_id)

    conn =
      conn
      |> assign(:current_client_id, extract_client_id(conn))
      |> assign(:current_user_id, user_id)
      |> assign(:current_user, user)
      |> assign(:current_subject, {:user, user_id})

    {:ok, conn}
  end

  defp assign_subject(conn, %Session{id: session_id, user_id: nil, visitor_id: visitor_id})
       when is_binary(visitor_id) do
    case Visitors.touch(visitor_id) do
      {:ok, %Visitor{} = visitor} ->
        conn =
          conn
          |> assign(:current_client_id, extract_client_id(conn))
          |> assign(:current_visitor_id, visitor_id)
          |> assign(:current_visitor, visitor)
          |> assign(:current_subject, {:visitor, visitor_id})

        {:ok, conn}

      {:error, :expired} ->
        # C1: W11 invariant — anon visitor lifecycle is co-terminus with
        # its accounts_sessions row. Synchronously revoke + purge so a
        # concurrent re-login by the same nick doesn't trip the
        # `(nick, network_slug)` uniqueness constraint against a
        # tombstone while waiting for the Reaper's 60s tick. Registered
        # visitors keep their row (purge_if_anon is a no-op) but the
        # session still revokes.
        :ok = Accounts.revoke_session(session_id)
        :ok = Visitors.purge_if_anon(visitor_id)
        {:error, :expired_visitor}

      {:error, :not_found} ->
        # Session row exists, visitor row vanished — the FK is
        # ON DELETE CASCADE (Q-H), so this is an invariant violation.
        # `Accounts.authenticate/1` already gated on session liveness;
        # if the visitor row disappeared mid-request we want the
        # operator log to flag it AND revoke the orphan session so the
        # bearer dies immediately.
        :ok = Accounts.revoke_session(session_id)
        {:error, :visitor_missing}
    end
  end

  defp extract_client_id(conn) do
    case get_req_header(conn, "x-grappa-client-id") do
      [value | _] when is_binary(value) ->
        if valid_client_id?(value), do: value, else: nil

      _ ->
        nil
    end
  end

  # Accept any URL-safe ASCII string up to 64 bytes. cicchetto generates
  # a UUID v4 (36 chars), but the server contract is "opaque token, server
  # stores verbatim". Defensive cap protects schema (varchar) from absurd
  # values without forcing a UUID-strict regex that ties cicchetto's
  # implementation choice to the server.
  defp valid_client_id?(value) when is_binary(value) do
    byte_size(value) > 0 and byte_size(value) <= 64 and String.match?(value, @client_id_regex)
  end

  defp get_token(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> {:ok, token}
      _ -> :error
    end
  end

  # M5: 401 body shape lives in one module — `FallbackController`.
  # The plug runs upstream of every controller's `action_fallback`,
  # so we invoke the fallback directly with `{:error, :unauthorized}`.
  defp unauthorized(conn) do
    conn
    |> FallbackController.call({:error, :unauthorized})
    |> halt()
  end
end
