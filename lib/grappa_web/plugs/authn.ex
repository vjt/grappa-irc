defmodule GrappaWeb.Plugs.Authn do
  @moduledoc """
  Bearer-token authn plug for the JSON REST surface.

  On a valid `Authorization: Bearer <uuid>` header backed by a live
  session, the plug branches on the session row's FK (per Q-A's XOR
  shape — `user_id` xor `visitor_id` always exactly one populated):

    * **User session** → assigns
      `:current_subject = {:user, %Accounts.User{}}` and
      `:current_session_id`.
    * **Visitor session** → assigns
      `:current_subject = {:visitor, %Visitors.Visitor{}}` and
      `:current_session_id`. The plug ALSO calls `Visitors.touch/1`
      for the W9 sliding-TTL refresh — visitor activity over the REST
      surface counts as user-initiated traffic. Cadence (≥1h) is
      handled inside `touch/1`.

  M-web-1 (B6.2) — single source of truth: the loaded subject struct
  lives ONLY inside the `:current_subject` tagged tuple. There is no
  parallel `:current_user` / `:current_visitor` assign to drift out of
  sync — a future race where one is set and the other is not is now a
  compile-time impossibility. Consumers pattern-match on the tuple
  directly and convert to the `t:Grappa.Session.subject/0` ID-tuple via
  `GrappaWeb.Subject.to_session/1` when delegating to the Session /
  Scrollback boundary (which speaks IDs, not structs).

  `:current_client_id` is populated upstream by
  `GrappaWeb.Plugs.ClientId` (wired into the `:api` pipeline) so both
  authenticated routes AND `/auth/login` see the same assign. Read by
  the admission gates and `AuthController` for per-client session
  tracking.

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
    {:ok, assign(conn, :current_subject, {:user, user})}
  end

  defp assign_subject(conn, %Session{id: session_id, user_id: nil, visitor_id: visitor_id})
       when is_binary(visitor_id) do
    case Visitors.touch(visitor_id) do
      {:ok, %Visitor{} = visitor} ->
        {:ok, assign(conn, :current_subject, {:visitor, visitor})}

      {:error, :expired} ->
        # C1: W11 invariant — anon visitor lifecycle is co-terminus with
        # its accounts_sessions row. Synchronously revoke + purge so a
        # concurrent re-login by the same nick doesn't trip the
        # `(nick, network_slug)` uniqueness constraint against a
        # tombstone while waiting for the Reaper's 60s tick. Registered
        # visitors keep their row (purge_if_anon is a no-op) but the
        # session still revokes.
        :ok = revoke_stale_session(session_id, :expired_visitor)
        :ok = Visitors.purge_if_anon(visitor_id)
        {:error, :expired_visitor}

      {:error, :not_found} ->
        # Session row exists, visitor row vanished — the FK is
        # ON DELETE CASCADE (Q-H), so this is an invariant violation.
        # `Accounts.authenticate/1` already gated on session liveness;
        # if the visitor row disappeared mid-request we want the
        # operator log to flag it AND revoke the orphan session so the
        # bearer dies immediately.
        :ok = revoke_stale_session(session_id, :visitor_missing)
        {:error, :visitor_missing}
    end
  end

  # #636 — co-terminus cleanup on a request the plug has ALREADY decided to
  # reject. Denial is the safe direction, so a revoke that degrades under
  # SQLITE_BUSY must not change the verdict — and must not crash it either,
  # which is what the former `:ok = Accounts.revoke_session(...)` binding did
  # over an unretried `update_all`. It logs and the 401 proceeds. Self-healing:
  # the visitor is expired or gone, so the very next request re-enters this
  # branch and re-attempts the revoke. Deliberately the OPPOSITE call from
  # `AuthController.logout/2`, which surfaces the same degrade as a 503 —
  # there a 204 would promise a logout that did not happen; here the caller
  # is being denied either way.
  @spec revoke_stale_session(Ecto.UUID.t(), :expired_visitor | :visitor_missing) :: :ok
  defp revoke_stale_session(session_id, reason) do
    case Accounts.revoke_session(session_id) do
      :ok ->
        :ok

      {:error, :db_unavailable} ->
        Logger.warning(
          "authn: stale visitor session revoke degraded (db unavailable) — " <>
            "request still rejected, revoke retried on the next request",
          authn_failure: reason
        )
    end
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
