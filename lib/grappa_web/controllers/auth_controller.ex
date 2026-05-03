defmodule GrappaWeb.AuthController do
  @moduledoc """
  REST authentication endpoints.

    * `POST /auth/login` — `{identifier, password?}` →
      `{token, subject: {kind, id, ...}}`. Dispatched by
      `Grappa.Auth.IdentifierClassifier`:
      - `@` present → mode-1 admin → name-keyed lookup against the
        local-part via `Accounts.get_user_by_credentials/2` (password
        REQUIRED). Phase 5 hardening adds a real email column.
      - else → visitor path → `Grappa.Visitors.Login.login/2` (password
        OPTIONAL — required only for registered visitors).
    * `DELETE /auth/logout` — revokes the session bound to the bearer
      token via the `:authn` pipeline. Idempotent.

  Login records the requesting `ip` + `user-agent` on the session row
  for audit (`Accounts.create_session/3`). The IP is read directly from
  `conn.remote_ip` — Phase 5 will add a configurable trusted-proxy
  list before honoring `x-forwarded-for`.

  Visitor case-3 (anon collision token reuse, W13) consumes the inbound
  `Authorization: Bearer <uuid>` header to rotate the holder's token
  without preempting the live `Session.Server`. The header is extracted
  inline because `/auth/login` is NOT behind `:authn` (login is the
  surface that mints the token in the first place).

  `:current_client_id` is populated by `GrappaWeb.Plugs.ClientId`
  (wired into the `:api` pipeline so login + every authenticated route
  share one extraction site).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, Networks, Session, Visitors}
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Visitors.{Login, Visitor}

  require Logger

  @anon_retry_after_ceiling_seconds 48 * 3600
  @visitor_network_slug Application.compile_env(:grappa, :visitor_network)

  @doc """
  `POST /auth/login` — `{identifier, password?}` →
  `{token, subject: {kind, id, ...}}`.

  Validates the input shape at the boundary (identifier present + binary)
  and returns 400 otherwise. Dispatch is delegated to
  `IdentifierClassifier`; per-branch failures map to canonical HTTP
  statuses (see moduledoc + `visitor_login/3`).
  """
  @spec login(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, atom() | {:network_circuit_open, non_neg_integer()}}
  def login(conn, %{"identifier" => id} = params) when is_binary(id) do
    password = Map.get(params, "password")

    case IdentifierClassifier.classify(id) do
      {:email, email} -> mode1_login(conn, email, password)
      {:nick, nick} -> visitor_login(conn, nick, password)
      {:error, :malformed} -> send_error(conn, 400, "malformed_nick")
    end
  end

  def login(conn, _), do: send_error(conn, 400, "bad_request")

  @doc """
  `DELETE /auth/logout` — revokes the session whose token was just
  validated by `GrappaWeb.Plugs.Authn`. For visitor sessions, also
  tears down the live `Session.Server` and purges the anon visitor
  row per W11 ("anon visitor lifecycle co-terminus with
  accounts_sessions row"). Registered visitors stay automatically —
  `Visitors.purge_if_anon/1` short-circuits when `password_encrypted`
  is set. Returns 204 + empty body.

  Order matters: stop the Session.Server BEFORE purging the visitor
  row so the GenServer's mailbox drains via `terminate/2` without any
  in-flight scrollback persist tripping the `messages.visitor_id` FK.
  """
  @spec logout(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def logout(conn, _) do
    :ok = maybe_terminate_visitor(conn.assigns)
    :ok = Accounts.revoke_session(conn.assigns.current_session_id)
    send_resp(conn, :no_content, "")
  end

  @spec maybe_terminate_visitor(map()) :: :ok
  defp maybe_terminate_visitor(%{current_visitor: %Visitor{} = visitor}) do
    :ok = stop_visitor_session(visitor)
    :ok = Visitors.purge_if_anon(visitor.id)
  end

  defp maybe_terminate_visitor(_), do: :ok

  @spec stop_visitor_session(Visitor.t()) :: :ok
  defp stop_visitor_session(%Visitor{} = visitor) do
    case Networks.get_network_by_slug(visitor.network_slug) do
      {:ok, %Networks.Network{id: network_id}} ->
        :ok = Session.stop_session({:visitor, visitor.id}, network_id)

      {:error, :not_found} ->
        Logger.warning("visitor logout but network not found",
          visitor_id: visitor.id,
          network: visitor.network_slug
        )

        :ok
    end
  end

  defp mode1_login(conn, _, nil), do: send_error(conn, 401, "invalid_credentials")

  defp mode1_login(conn, email, password) when is_binary(password) do
    # Mode-1 today is name-keyed. Phase 5 hardening adds a real email
    # column; for now the dispatch routes by `@` presence but the lookup
    # uses the local-part as the user `name`.
    name = email |> String.split("@", parts: 2) |> List.first()

    with {:ok, user} <- Accounts.get_user_by_credentials(name, password) do
      {:ok, session} =
        Accounts.create_session({:user, user.id}, format_ip(conn), user_agent(conn))

      conn
      |> put_status(:ok)
      |> render(:login, token: session.id, subject: {:user, user})
    end
  end

  defp visitor_login(conn, nick, password) do
    input = %{
      nick: nick,
      password: password,
      ip: format_ip(conn),
      user_agent: user_agent(conn),
      token: extract_bearer(conn),
      captcha_token: conn.params["captcha_token"],
      client_id: conn.assigns[:current_client_id]
    }

    case Login.login(input, []) do
      {:ok, %{visitor: %Visitor{} = v, token: token}} ->
        conn
        |> put_status(:ok)
        |> render(:login, token: token, subject: {:visitor, v})

      {:error, reason} ->
        visitor_error_response(conn, nick, reason)
    end
  end

  defp visitor_error_response(conn, _, :malformed_nick),
    do: send_error(conn, 400, "malformed_nick")

  defp visitor_error_response(conn, _, :password_required),
    do: send_error(conn, 401, "password_required")

  defp visitor_error_response(conn, _, :password_mismatch),
    do: send_error(conn, 401, "password_mismatch")

  # T31 Plan 2 Task 5: admission + captcha atoms flow through
  # `GrappaWeb.FallbackController` (wired globally via `use GrappaWeb,
  # :controller`). Returning `{:error, reason}` here dispatches the
  # canonical wire shape: 429 too_many_sessions / 503 network_busy /
  # 503 network_unreachable+Retry-After / 400 captcha_required+site_key /
  # 400 captcha_failed / 503 service_degraded. The matching clause is
  # spelled exactly so the inline action's contract stays auditable
  # without grepping the FallbackController.
  defp visitor_error_response(_, _, :client_cap_exceeded),
    do: {:error, :client_cap_exceeded}

  defp visitor_error_response(_, _, :network_cap_exceeded),
    do: {:error, :network_cap_exceeded}

  defp visitor_error_response(_, _, {:network_circuit_open, _} = err),
    do: {:error, err}

  defp visitor_error_response(_, _, :captcha_required),
    do: {:error, :captcha_required}

  defp visitor_error_response(_, _, :captcha_failed),
    do: {:error, :captcha_failed}

  defp visitor_error_response(_, _, :captcha_provider_unavailable),
    do: {:error, :captcha_provider_unavailable}

  defp visitor_error_response(conn, nick, :anon_collision),
    do: anon_collision_response(conn, nick)

  defp visitor_error_response(conn, _, :upstream_unreachable),
    do: send_error(conn, 502, "upstream_unreachable")

  defp visitor_error_response(conn, _, :timeout),
    do: send_error(conn, 504, "timeout")

  defp visitor_error_response(conn, _, _),
    do: send_error(conn, 500, "internal")

  defp anon_collision_response(conn, nick) do
    seconds =
      case Visitors.get_by_nick_and_network(nick, @visitor_network_slug) do
        %Visitor{expires_at: expires_at} ->
          expires_at
          |> DateTime.diff(DateTime.utc_now())
          |> max(1)
          |> min(@anon_retry_after_ceiling_seconds)

        nil ->
          @anon_retry_after_ceiling_seconds
      end

    conn
    |> put_resp_header("retry-after", Integer.to_string(seconds))
    |> send_error(409, "anon_collision")
  end

  defp send_error(conn, status, code) do
    conn |> put_status(status) |> json(%{error: code})
  end

  defp extract_bearer(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> token
      _ -> nil
    end
  end

  @spec format_ip(Plug.Conn.t()) :: String.t() | nil
  defp format_ip(%Plug.Conn{remote_ip: nil}), do: nil
  defp format_ip(%Plug.Conn{remote_ip: ip}), do: ip |> :inet.ntoa() |> to_string()

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
