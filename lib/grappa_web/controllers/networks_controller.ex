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

  On `:connected` transition: the controller orchestrates admission
  check + `Backoff.reset` + `Session.start_session/3`. The
  `Networks.connect/1` context fn only does the DB write + PubSub
  broadcast (no spawn) — spawn lives here per the S1.2 boundary note:
  `Networks` must not dep `Admission` to avoid a cycle.

  Wire shape lives in `Grappa.Networks.Wire.network_to_json/1` (GET)
  and `Grappa.Networks.Wire.credential_to_json/1` (PATCH). The view
  layer (`NetworksJSON`) is a thin delegator.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.{Admission, Networks, Session}
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Session.Backoff

  @doc "`GET /networks` — list of network metadata for the bearer's subject."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    case conn.assigns.current_subject do
      {:user, user} ->
        network_nicks =
          user
          |> Credentials.list_credentials_for_user()
          |> Enum.map(&{&1.network, &1.nick})

        render(conn, :index, networks: {:user, network_nicks})

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

  # Mirrors `Bootstrap.spawn_with_admission/6` but for the REST surface.
  # Per the S1.2 boundary note: `Networks.connect/1` does DB + broadcast
  # only; the admission + backoff-reset + start_session orchestration
  # lives HERE so `Networks` doesn't dep `Admission` (which already deps
  # `Networks` for cap reads — adding the reverse edge closes a cycle).
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

    with :ok <- Admission.check_capacity(capacity_input),
         :ok <- Backoff.reset({:user, user_id}, network_id),
         {:ok, plan} <- plan_or_warn(credential, user),
         {:ok, _} <- start_or_warn(user, network_id, plan) do
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

  @spec start_or_warn(User.t(), integer(), Session.start_opts()) ::
          {:ok, pid()} | {:error, :start_failed}
  defp start_or_warn(user, network_id, plan) do
    case Session.start_session({:user, user.id}, network_id, plan) do
      {:ok, pid} ->
        {:ok, pid}

      {:error, {:already_started, pid}} ->
        {:ok, pid}

      {:error, reason} ->
        require Logger

        Logger.warning("PATCH /connect: session start failed",
          user: user.id,
          error: inspect(reason)
        )

        {:error, :start_failed}
    end
  end
end
