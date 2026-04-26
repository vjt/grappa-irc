defmodule GrappaWeb.AuthController do
  @moduledoc """
  REST authentication endpoints.

    * `POST /auth/login`   — exchange `{name, password}` for a bearer
      token. Returns `200 {token, user: {id, name}}` on success;
      `401 {error: "invalid_credentials"}` on either wrong username or
      wrong password (uniform response — see
      `Grappa.Accounts.get_user_by_credentials/2` for the timing-oracle
      rationale).
    * `DELETE /auth/logout` — revokes the session bound to the bearer
      token via the `:authn` pipeline. Idempotent: calling it twice
      with the same (already-revoked) token would 401 on the second
      attempt because the plug rejects revoked sessions before this
      action runs.

  Login records the requesting `ip` + `user-agent` on the session row
  for audit (`Accounts.create_session/3`). The IP is read directly from
  `conn.remote_ip` — Phase 5 will add a configurable trusted-proxy
  list before honoring `x-forwarded-for`. Trusting the header on
  Phase 2 would let an unauthenticated client forge audit metadata.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts

  @doc """
  `POST /auth/login` — `{name, password}` → `{token, user: {id, name}}`.

  Validates the input shape at the boundary (both keys present, both
  strings) and returns 400 otherwise — matches the rest of the JSON
  surface's malformed-body handling.
  """
  @spec login(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :invalid_credentials | Ecto.Changeset.t()}
  def login(conn, %{"name" => name, "password" => password})
      when is_binary(name) and is_binary(password) do
    with {:ok, user} <- Accounts.get_user_by_credentials(name, password),
         {:ok, session} <- Accounts.create_session(user.id, format_ip(conn), user_agent(conn)) do
      conn
      |> put_status(:ok)
      |> render(:login, token: session.id, user: user)
    end
  end

  def login(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /auth/logout` — revokes the session whose token was just
  validated by `GrappaWeb.Plugs.Authn`. Returns 204 + empty body.
  """
  @spec logout(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def logout(conn, _) do
    :ok = Accounts.revoke_session(conn.assigns.current_session_id)
    send_resp(conn, :no_content, "")
  end

  defp format_ip(%Plug.Conn{remote_ip: nil}), do: nil
  defp format_ip(%Plug.Conn{remote_ip: ip}), do: ip |> :inet.ntoa() |> to_string()

  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
