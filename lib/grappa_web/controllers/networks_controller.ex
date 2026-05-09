defmodule GrappaWeb.NetworksController do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.
  `PATCH /networks/:network_id` — T32 connection_state transitions.

  Cicchetto (Phase 3 PWA) calls GET on app boot to render the
  network → channel tree. Two subject branches:

    * **user** — `Credentials.list_credentials_for_user/1` returns
      every credential row the user has bound. Per-user iso is
      load-bearing: a user only sees networks they have a credential
      on.
    * **visitor** — visitors are pinned to one network at row
      creation (`visitor.network_slug`). Returns the single matching
      network row. The slug invariant is enforced by `Bootstrap` at
      boot (a `GRAPPA_VISITOR_NETWORK` rotation hard-errors with
      operator instructions to reap orphans), so the lookup never
      returns `:not_found` in production — but the controller
      collapses to the empty list rather than crashing the request
      to keep the wire shape uniform under the pathological
      orphan-row case.

  PATCH is user-only — `Credential` rows are per-(user, network)
  bindings; visitors have no `Credential` to transition. The
  `ResolveNetwork` plug provides the ownership check: a user patching
  another user's network slug gets a uniform 404 from the plug so
  credential existence is not leaked.

  ## T32 connection_state transitions

  Clients may only set `:connected` or `:parked`. `:failed` is a
  server-internal terminal state (k-line / permanent SASL failure —
  see plan S1.4 lenient triggers). A request to set `:failed` returns
  400.

  On `:connected` transition: the controller delegates to
  `Grappa.SpawnOrchestrator.spawn/4` for the admission check +
  `Backoff.reset` + `Session.start_session/3` dance (cluster #8 —
  shared with `Grappa.Bootstrap`). The `Networks.connect/1` context
  fn only does the DB write + PubSub broadcast (no spawn) — spawn
  lives in the orchestrator per the S1.2 boundary note: `Networks`
  must not dep `Admission` to avoid a cycle, and the orchestrator's
  own top-level boundary deps both freely.

  Wire shape lives in `Grappa.Networks.Wire.network_to_json/1` (GET)
  and `Grappa.Networks.Wire.credential_to_json/1` (PATCH). The view
  layer (`NetworksJSON`) is a thin delegator.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.{Networks, Session}
  alias Grappa.Networks.{Credential, Credentials, SessionPlan}

  @doc "`GET /networks` — list of network metadata for the bearer's subject."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    case conn.assigns.current_subject do
      {:user, user} ->
        credentials = Credentials.list_credentials_for_user(user)

        # BUG1-FIX: use the live IRC nick from the running Session rather
        # than the credential's configured nick. The two diverge whenever
        # NickServ forces a ghost/regain recovery suffix or the operator
        # issues /nick. Cicchetto uses this nick to subscribe to the
        # own-nick DM topic — a stale nick silently drops all inbound DMs.
        # Fall back to credential nick when the session is parked/failed.
        # `resolve_network_nick/2` is extracted to keep nesting ≤ 2 (Credo).
        #
        # T32 (CP19 parked-window): the credential is also threaded through
        # so the wire shape can carry the T32 connection-state fields cic
        # needs to derive the per-network + cascading per-channel greyed
        # treatment. nick stays the live-vs-configured Session.Server
        # value; T32 fields come straight off the credential row of record.
        network_triples =
          Enum.map(credentials, fn cred ->
            {cred.network, resolve_network_nick(user.id, cred), cred}
          end)

        render(conn, :index, networks: {:user, network_triples})

      {:visitor, visitor} ->
        networks =
          case Networks.get_network_by_slug(visitor.network_slug) do
            {:ok, network} -> [network]
            {:error, :not_found} -> []
          end

        render(conn, :index, networks: {:visitor, networks})
    end
  end

  @doc """
  `PATCH /networks/:network_id` — T32 connection_state transition.

  Accepts `{connection_state: "parked" | "connected", reason: string|nil}`.
  `:failed` is server-set only — returns 400 to the caller.
  User subject only — visitors have no `Credential` row to transition.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :forbidden | :not_found | :not_connected}
  def update(conn, params) do
    with {:ok, subject_user} <- require_user_subject(conn),
         {:ok, target_state} <- parse_connection_state(params),
         {:ok, reason} <- parse_reason(params),
         {:ok, credential} <- fetch_credential(subject_user, conn.assigns.network),
         {:ok, updated_cred} <- apply_transition(conn, subject_user, credential, target_state, reason) do
      render(conn, :update, credential: updated_cred)
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # BUG1-FIX: resolve the live IRC nick for a (user_id, credential) pair.
  # Asks the running Session.Server for its current nick — which may differ
  # from `cred.nick` after NickServ ghost/regain or an explicit /nick.
  # Falls back to the credential's configured nick when the session is
  # parked, failed, or not yet bootstrapped.
  @spec resolve_network_nick(Ecto.UUID.t(), Credential.t()) :: String.t()
  defp resolve_network_nick(user_id, cred) do
    case Session.current_nick({:user, user_id}, cred.network_id) do
      {:ok, nick} -> nick
      {:error, :no_session} -> cred.nick
    end
  end

  @spec require_user_subject(Plug.Conn.t()) ::
          {:ok, User.t()} | {:error, :forbidden}
  defp require_user_subject(%{assigns: %{current_subject: {:user, %User{} = user}}}),
    do: {:ok, user}

  defp require_user_subject(_),
    do: {:error, :forbidden}

  # Only `:connected` and `:parked` are user-settable. `:failed` is
  # server-set only (k-line / permanent SASL — S1.4 lenient triggers);
  # returning :bad_request keeps the public surface closed without
  # leaking that `:failed` is a valid DB state.
  @spec parse_connection_state(map()) ::
          {:ok, Credential.connection_state()} | {:error, :bad_request}
  defp parse_connection_state(%{"connection_state" => "connected"}), do: {:ok, :connected}
  defp parse_connection_state(%{"connection_state" => "parked"}), do: {:ok, :parked}
  defp parse_connection_state(%{"connection_state" => _}), do: {:error, :bad_request}
  defp parse_connection_state(_), do: {:error, :bad_request}

  # Optional reason string. Validated for CRLF/NUL safety so it can be
  # forwarded upstream as the IRC QUIT reason without injection risk.
  @spec parse_reason(map()) :: {:ok, String.t() | nil} | {:error, :bad_request}
  defp parse_reason(%{"reason" => reason}) when is_binary(reason) do
    if Identifier.safe_line_token?(reason),
      do: {:ok, reason},
      else: {:error, :bad_request}
  end

  defp parse_reason(_), do: {:ok, nil}

  @spec fetch_credential(User.t(), Grappa.Networks.Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  defp fetch_credential(user, network), do: Credentials.get_credential(user, network)

  # Dispatch to the right context fn based on the target state.
  @spec apply_transition(
          Plug.Conn.t(),
          User.t(),
          Credential.t(),
          Credential.connection_state(),
          String.t() | nil
        ) :: {:ok, Credential.t()} | {:error, atom()}
  defp apply_transition(_, _, credential, :parked, reason) do
    Networks.disconnect(credential, reason || "user-disconnect")
  end

  defp apply_transition(conn, user, credential, :connected, _) do
    with {:ok, updated_cred} <- Networks.connect(credential) do
      spawn_session_after_connect(conn, user, updated_cred)
      {:ok, updated_cred}
    end
  end

  # Wrapper over `Grappa.SpawnOrchestrator.spawn/4` for the REST
  # surface. Per the S1.2 boundary note: `Networks.connect/1` does
  # DB + broadcast only; the admission + backoff-reset + start_session
  # orchestration lives via the orchestrator (which deps both
  # `Admission` and `Session` from its own top-level boundary, so
  # `Networks` doesn't need to dep `Admission` — that would close
  # the cycle Networks → Admission → Networks).
  #
  # If admission rejects, the DB row is already `:connected` (user intent
  # persisted). Bootstrap or the next operator `/connect` will retry.
  # We log the rejection but still return `:ok` to the caller — the
  # transition succeeded from the credential perspective.
  @spec spawn_session_after_connect(Plug.Conn.t(), User.t(), Credential.t()) :: :ok
  defp spawn_session_after_connect(conn, %User{id: user_id} = user, credential) do
    network_id = credential.network_id
    client_id = conn.assigns[:current_client_id]

    capacity_input = %{
      network_id: network_id,
      client_id: client_id,
      flow: :patch_network_connect
    }

    with {:ok, plan} <- plan_or_warn(credential, user),
         {:ok, _} <-
           orchestrate_or_warn({:user, user_id}, network_id, plan, capacity_input, user) do
      :ok
    else
      {:error, _} -> :ok
    end
  end

  @spec plan_or_warn(Credential.t(), User.t()) ::
          {:ok, Session.start_opts()} | {:error, :resolve_failed}
  defp plan_or_warn(credential, user) do
    case SessionPlan.resolve(credential) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        require Logger

        Logger.warning("PATCH /connect: session plan resolve failed",
          user: user.id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  @spec orchestrate_or_warn(
          Session.subject(),
          integer(),
          Session.start_opts(),
          Grappa.Admission.capacity_input(),
          User.t()
        ) :: {:ok, pid()} | {:error, :spawn_rejected}
  defp orchestrate_or_warn(subject, network_id, plan, capacity_input, user) do
    case Grappa.SpawnOrchestrator.spawn(subject, network_id, plan, capacity_input) do
      {:ok, _, pid} ->
        {:ok, pid}

      {:error, reason} ->
        require Logger

        Logger.warning("PATCH /connect: session spawn rejected",
          user: user.id,
          error: inspect(reason)
        )

        {:error, :spawn_rejected}
    end
  end
end
