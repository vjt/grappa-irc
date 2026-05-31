defmodule GrappaWeb.ShareTokenController do
  @moduledoc """
  Visitor session-sharing endpoints.

    * `POST /me/share-token` — visitor-only. Mints a Phoenix-signed,
      short-TTL token bound to the visitor's id. cic wraps the token in
      a shareable URL (`https://<host>/#/share/<token>`) so the visitor
      can forward it to another device of their own.
    * `POST /auth/share/consume` — unauthenticated. Body `{token}`.
      Verifies signature + TTL, checks the one-shot ETS ledger
      (`Grappa.Visitors.ShareTokens`), confirms the visitor row still
      exists, and mints a fresh `accounts_sessions` row for the SAME
      visitor. Returns `{token, subject}` mirroring the login wire.

  ## Why visitor-only

  Users have passwords. They can log in directly on the second device
  and re-use existing sessions normally. The 409 "anon conflict" that
  blocks a visitor from logging in via the standard nick path on a
  second device is the precise gap this flow closes — visitors have no
  password, so the link IS the auth mechanism.

  ## Why Phoenix.Token + ETS (no DB)

  Threat model is benign (operator clicks own link twice). Short TTL
  (10 min). Losing the consumed-set on BEAM restart opens at most a
  TTL-bounded reuse window for tokens already signed. The benefit is
  zero migrations → HOT-deploy-friendly. A future DB-backed hardening
  path (`visitor_share_tokens` table with `consumed_at`) is a
  mechanical migration if the threat model shifts.

  ## Error envelope

  All error responses flow through `GrappaWeb.FallbackController`
  (wired via `use GrappaWeb, :controller`). The new error atoms this
  surface contributes are:

    * `:share_token_expired` → 410 Gone
    * `:share_token_consumed` → 410 Gone

  Reused: `:forbidden` (user trying to mint), `:bad_request` (missing
  token param), `:unauthorized` (invalid signature), `:not_found`
  (visitor row gone between mint and consume).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, Visitors}
  alias Grappa.Accounts.User
  alias Grappa.Visitors.{ShareTokens, Visitor}
  alias Grappa.Visitors.Wire, as: VisitorsWire
  alias GrappaWeb.RemoteIP

  @salt "visitor-share-v1"
  @max_age_seconds 600

  @doc false
  @spec salt() :: String.t()
  def salt, do: @salt

  @doc false
  @spec max_age_seconds() :: unquote(@max_age_seconds)
  def max_age_seconds, do: @max_age_seconds

  @doc """
  `POST /me/share-token` — visitor-only mint.

  Returns `{token, expires_at}`. `expires_at` is the absolute UTC
  ISO8601 timestamp at which the token will be rejected by the
  consume endpoint (TTL elapsed) — cic uses this for the countdown
  in the share modal.

  Users get 403 explicitly: the feature is meaningless for a
  password-holding identity.
  """
  @spec mint(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden}
  def mint(conn, _) do
    case conn.assigns[:current_subject] do
      {:visitor, %Visitor{id: visitor_id}} ->
        token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor_id)
        expires_at = DateTime.add(DateTime.utc_now(), @max_age_seconds, :second)

        :telemetry.execute(
          [:grappa, :visitor, :share_token, :minted],
          %{count: 1},
          %{visitor_id: visitor_id}
        )

        conn
        |> put_status(:ok)
        |> json(%{token: token, expires_at: DateTime.to_iso8601(expires_at)})

      {:user, %User{}} ->
        {:error, :forbidden}

      _ ->
        # Defensive fall-through — `:authn` should have rejected
        # already, but a regressed pipeline would land here. 401 via
        # FallbackController matches the broader unauth surface.
        {:error, :unauthorized}
    end
  end

  @doc """
  `POST /auth/share/consume` — unauthenticated, body `{token}`.

  Flow:
    1. Validate body shape (token present + binary) → 400 otherwise.
    2. `Phoenix.Token.verify` with `@salt` + `@max_age_seconds` →
       401 on bad signature, 410 on TTL elapsed.
    3. `ShareTokens.mark_consumed/1` (atomic ETS insert-if-absent) →
       410 on second redemption.
    4. `Visitors.get/1` → 404 if the row was reaped between mint and
       consume.
    5. `Accounts.create_session/4` for the SAME visitor row →
       returns the new bearer + the visitor's subject envelope.

  IP + user-agent are captured for audit just like login.
  """
  @spec consume(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error,
             :bad_request
             | :unauthorized
             | :share_token_expired
             | :share_token_consumed
             | :not_found}
  def consume(conn, %{"token" => token}) when is_binary(token) and token != "" do
    with {:ok, visitor_id} <- verify_token(token),
         :ok <- mark_consumed(token),
         {:ok, visitor} <- fetch_visitor(visitor_id) do
      {:ok, session} =
        Accounts.create_session(
          {:visitor, visitor.id},
          format_ip(conn),
          user_agent(conn),
          client_id: conn.assigns[:current_client_id]
        )

      :telemetry.execute(
        [:grappa, :visitor, :share_token, :consumed],
        %{count: 1},
        %{visitor_id: visitor.id}
      )

      conn
      |> put_status(:ok)
      |> json(%{
        token: session.id,
        subject:
          visitor
          |> VisitorsWire.visitor_to_credential_json()
          |> Map.put(:kind, "visitor")
      })
    else
      {:error, reason} = err ->
        :telemetry.execute(
          [:grappa, :visitor, :share_token, :rejected],
          %{count: 1},
          %{reason: reason}
        )

        err
    end
  end

  def consume(_, _), do: {:error, :bad_request}

  @spec verify_token(String.t()) ::
          {:ok, Ecto.UUID.t()}
          | {:error, :unauthorized | :share_token_expired}
  defp verify_token(token) do
    case Phoenix.Token.verify(GrappaWeb.Endpoint, @salt, token, max_age: @max_age_seconds) do
      {:ok, visitor_id} when is_binary(visitor_id) -> {:ok, visitor_id}
      {:error, :expired} -> {:error, :share_token_expired}
      {:error, _} -> {:error, :unauthorized}
    end
  end

  # Translates `ShareTokens.mark_consumed/1`'s `{:error,
  # :already_consumed}` into the controller's wire-shaped error atom
  # `:share_token_consumed` so `FallbackController` can map it to 410.
  # Keeps the ETS module's contract clean (it doesn't know about HTTP
  # wire strings) and puts the wire-shape lift right at the boundary.
  @spec mark_consumed(String.t()) :: :ok | {:error, :share_token_consumed}
  defp mark_consumed(token) do
    case ShareTokens.mark_consumed(token) do
      :ok -> :ok
      {:error, :already_consumed} -> {:error, :share_token_consumed}
    end
  end

  @spec fetch_visitor(Ecto.UUID.t()) :: {:ok, Visitor.t()} | {:error, :not_found}
  defp fetch_visitor(visitor_id) do
    case Visitors.get(visitor_id) do
      %Visitor{} = v -> {:ok, v}
      nil -> {:error, :not_found}
    end
  end

  @spec format_ip(Plug.Conn.t()) :: String.t() | nil
  defp format_ip(conn), do: RemoteIP.format(conn)

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
