defmodule GrappaWeb.Plugs.Authn do
  @moduledoc """
  Bearer-token authn plug for the JSON REST surface.

  On a valid `Authorization: Bearer <uuid>` header backed by a live
  session, assigns `:current_user_id`, `:current_session_id`, and
  `:current_user` (the loaded `%Accounts.User{}`) and passes the conn
  through. Loading the user here costs one DB round-trip per
  authenticated request but eliminates the `Accounts.get_user!/1`
  re-fetch each user-aware controller used to perform — net one query
  saved per Me/Networks/Channels-index call, plus controllers stay
  thin. The session FK is `ON DELETE CASCADE`, so a missing user is an
  invariant violation and `get_user!/1` raising is the right shape
  (S42).

  On any failure (missing header, wrong scheme, malformed token,
  unknown / revoked / expired session) the plug halts with a 401 JSON
  body — no leak of which failure mode triggered it (deliberate,
  mirrors the `get_user_by_credentials/2` oracle posture in
  `Grappa.Accounts`).

  Channels do their own auth in `UserSocket.connect/3` — this plug is
  HTTP-only.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.Accounts
  alias GrappaWeb.FallbackController

  require Logger

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    case get_token(conn) do
      {:ok, token} ->
        case Accounts.authenticate(token) do
          {:ok, session} ->
            user = Accounts.get_user!(session.user_id)

            conn
            |> assign(:current_user_id, session.user_id)
            |> assign(:current_session_id, session.id)
            |> assign(:current_user, user)

          {:error, reason} ->
            # Reason stays in operator logs (greppable) but never reaches
            # the wire — the 401 body is uniform on purpose so the plug
            # doesn't leak token-state to a probing attacker.
            Logger.info("authn rejected", authn_failure: reason)
            unauthorized(conn)
        end

      :error ->
        Logger.info("authn rejected", authn_failure: :no_bearer)
        unauthorized(conn)
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
