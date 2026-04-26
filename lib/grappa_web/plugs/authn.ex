defmodule GrappaWeb.Plugs.Authn do
  @moduledoc """
  Bearer-token authn plug for the JSON REST surface.

  On a valid `Authorization: Bearer <uuid>` header backed by a live
  session, assigns `:current_user_id` and `:current_session_id` and
  passes the conn through. On any failure (missing header, wrong
  scheme, malformed token, unknown / revoked / expired session) the
  plug halts with a 401 JSON body — no leak of which failure mode
  triggered it (deliberate, mirrors the `get_user_by_credentials/2`
  oracle posture in `Grappa.Accounts`).

  Channels do their own auth in `UserSocket.connect/3` — this plug is
  HTTP-only.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.Accounts

  require Logger

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    case get_token(conn) do
      {:ok, token} ->
        case Accounts.authenticate(token) do
          {:ok, session} ->
            conn
            |> assign(:current_user_id, session.user_id)
            |> assign(:current_session_id, session.id)

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

  defp unauthorized(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(401, ~s({"error":"unauthorized"}))
    |> halt()
  end
end
