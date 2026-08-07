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

  Since #982 this is no longer the ONLY mint: an admin can mint the
  same token for a locked-out visitor via `POST
  /admin/visitors/:id/share-token`. The consume below stays the single
  redeem surface for both origins, and both mints go through
  `GrappaWeb.ShareToken` — see that module for why the salt and TTL
  cannot live in a controller any more.

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

  Reused: `:forbidden` (a user OR an incognito visitor trying to
  mint — #363), `:bad_request` (missing token param), `:unauthorized`
  (invalid signature), `:not_found` (visitor row gone between mint and
  consume).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, Visitors}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.{ShareTokens, Visitor}
  alias Grappa.Visitors.Wire, as: VisitorsWire
  alias GrappaWeb.{RemoteIP, ShareToken}

  @doc """
  `POST /me/share-token` — visitor-only mint.

  Returns `{token, expires_at}`. `expires_at` is the absolute UTC
  ISO8601 timestamp at which the token will be rejected by the
  consume endpoint (TTL elapsed) — cic uses this for the countdown
  in the share modal.

  Users get 403 explicitly: the feature is meaningless for a
  password-holding identity. Incognito visitors (#363) also get 403:
  an ephemeral session must not be made portable.
  """
  @spec mint(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden}
  def mint(conn, _) do
    case conn.assigns[:current_subject] do
      {:visitor, %Visitor{incognito: true}} ->
        # #363 — an incognito session is deliberately non-portable: its
        # whole point is "gone when this browser closes." Minting a share
        # link would carry the session to another device (and the shared
        # socket would keep the reconcile linger alive), defeating the
        # ephemerality. cic already hides the share control for incognito;
        # this is the server-side twin of that gate so the REST door can't
        # be driven directly ("one feature, every door").
        {:error, :forbidden}

      {:visitor, %Visitor{id: visitor_id}} ->
        {token, expires_at} = ShareToken.mint(visitor_id)

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

  Flow (claim-then-release, #593):
    1. Validate body shape (token present + binary) → 400 otherwise.
    2. `Phoenix.Token.verify` with `@salt` + `@max_age_seconds` →
       401 on bad signature, 410 on TTL elapsed.
    3. `ShareTokens.mark_consumed/1` (atomic ETS insert-if-absent) —
       the one-shot CLAIM → 410 on second redemption. From here the
       token is held by THIS request.
    4. `Visitors.get/1` → 404 if the row was reaped between mint and
       consume.
    5. `Accounts.create_session/4` for the SAME visitor row →
       returns the new bearer + the visitor's subject envelope.

  #593 — the claim (step 3) is taken BEFORE the mint (steps 4-5), so a
  failed mint would strand the token consumed with no session minted: a
  dead link the retryable-503 (#518) invites the client to retry in vain.
  `mint_session/3` closes that: ANY failure after the claim calls
  `ShareTokens.release/1` to roll the claim back, so a failed mint leaves
  the link usable and a successful mint leaves it dead. The release is
  scoped to THIS request's own post-claim failures — a second
  redemption's 410 (step 3) never releases the winner's claim.

  IP + user-agent are captured for audit just like login.
  """
  @spec consume(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error,
             :bad_request
             | :unauthorized
             | :share_token_expired
             | :share_token_consumed
             | :not_found
             | :db_unavailable
             | Ecto.Changeset.t()}
  def consume(conn, %{"token" => token}) when is_binary(token) and token != "" do
    with {:ok, visitor_id} <- ShareToken.verify(token),
         :ok <- mark_consumed(token) do
      # The one-shot claim is now HELD by this request (mark_consumed
      # returned :ok — we won any race). #593 — every failure past this
      # point MUST roll the claim back (claim-then-release), so a
      # retryable mint failure (a 503 under transient SQLite saturation,
      # #518) leaves the link usable instead of silently dead.
      mint_session(conn, token, visitor_id)
    else
      # Pre-consume rejects (bad signature / expired / lost the one-shot
      # race → :share_token_consumed). NOTHING to release here: either no
      # claim was taken, or the claim belongs to the WINNING request —
      # releasing it would resurrect a token that already minted a
      # session (dead-link → double-redemption, a worse bug).
      {:error, reason} -> reject(reason)
    end
  end

  def consume(_, _), do: {:error, :bad_request}

  # Mint the session for an already-CLAIMED token. On ANY failure the
  # claim is released (#593 claim-then-release) — safe because
  # `mark_consumed/1` returned `:ok` for THIS request just above, so the
  # token is ours to roll back, never a concurrent winner's. A failed
  # mint therefore leaves the link usable; a successful mint leaves the
  # claim in place (link dead), honouring the one-shot guarantee.
  @spec mint_session(Plug.Conn.t(), String.t(), Ecto.UUID.t()) ::
          Plug.Conn.t()
          | {:error, :not_found | :db_unavailable | Ecto.Changeset.t()}
  defp mint_session(conn, token, visitor_id) do
    with {:ok, visitor} <- fetch_visitor(visitor_id),
         {:ok, session} <-
           Accounts.create_session(
             {:visitor, visitor.id},
             format_ip(conn),
             user_agent(conn),
             client_id: conn.assigns[:current_client_id]
           ) do
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
          |> VisitorsWire.visitor_to_credential_json(Credentials.visitor_registered?(visitor.id))
          |> Map.put(:kind, "visitor")
      })
    else
      {:error, reason} ->
        ShareTokens.release(token)
        reject(reason)
    end
  end

  # The closed set of rejection reasons — pre-consume (bad sig / expired /
  # lost the one-shot race) and post-consume (visitor reaped / saturated
  # mint / mint changeset). Typed over a bare `atom()` per CLAUDE.md's
  # closed-set rule.
  @typep reject_reason ::
           :unauthorized
           | :share_token_expired
           | :share_token_consumed
           | :not_found
           | :db_unavailable
           | Ecto.Changeset.t()

  # Emit the rejection telemetry and return the wire error tuple, so
  # both the pre-consume and post-consume reject paths stay single-sourced.
  @spec reject(reject_reason()) :: {:error, reject_reason()}
  defp reject(reason) do
    :telemetry.execute(
      [:grappa, :visitor, :share_token, :rejected],
      %{count: 1},
      %{reason: reason}
    )

    {:error, reason}
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
