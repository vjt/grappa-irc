defmodule GrappaWeb.NetworksController do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.
  `PATCH /networks/:network_id` — T32 connection_state transitions.

  Cicchetto (Phase 3 PWA) calls GET on app boot to render the
  network → channel tree. Two subject branches, both list-shaped since
  #211 phase 6:

    * **user** — `Credentials.list_credentials_for_user/1` returns
      every credential row the user has bound. Per-user iso is
      load-bearing: a user only sees networks they have a credential
      on.
    * **visitor** — `Credentials.list_visitor_credentials/1` returns
      one row per attached network (multi-network since phase 4c
      accretion). The visitor twin of the user branch (ruling A):
      per-network live-nick + the (now-real) `connection_state`. The
      pre-phase-6 singular `visitor.network_slug` → `[single network]`
      branch is retired — the scalar is dropped from the wire this
      phase (the column at phase 7).

  PATCH is subject-agnostic since #211 phase 6 (ruling D): BOTH users
  and visitors park/reconnect a network through it — visitors carry a
  real `connection_state` now, so the visitor `POST /session/{disconnect,
  reconnect}` pair is RETIRED in favor of this one verb. The
  `ResolveNetwork` plug provides the ownership check for either subject:
  a caller patching a network they hold no credential on gets a uniform
  404 from the plug so credential existence is not leaked.

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

  Wire shapes live in `Grappa.Networks.Wire` — `network_with_nick_to_json/3`
  (user GET row), `visitor_network_to_json/3` (visitor GET row), and
  `credential_to_json/1` (PATCH). The view layer (`NetworksJSON`) is a
  thin delegator.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.{Networks, Session}
  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Visitors.Visitor

  require Logger

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
        # `Networks.resolve_network_nick/2` is the single-sourced lookup
        # shared with `Networks.home_data_for_user/1` (UX-4 bucket B).
        #
        # T32 (CP19 parked-window): the credential is also threaded through
        # so the wire shape can carry the T32 connection-state fields cic
        # needs to derive the per-network + cascading per-channel greyed
        # treatment. nick stays the live-vs-configured Session.Server
        # value; T32 fields come straight off the credential row of record.
        network_triples =
          Enum.map(credentials, fn cred ->
            {cred.network, Networks.resolve_network_nick({:user, user.id}, cred), cred}
          end)

        render(conn, :index, networks: {:user, network_triples})

      {:visitor, visitor} ->
        # #211 phase 6 — list-shaped visitor branch (ruling A). A visitor
        # is multi-network now (phase 4c accretion): return ONE row per
        # attached network — the visitor twin of the user branch, via the
        # 4c reader `Credentials.list_visitor_credentials/1` (`WHERE
        # visitor_id ==`, `:network` preloaded, subject-blind-safe). Each
        # row carries the live-nick-with-fallback + the credential's
        # `connection_state` (ruling D: visitors carry a real
        # connection_state now). Replaces the pre-phase-6 singular
        # `visitor.network_slug` → `[single network]` branch (the scalar
        # is dropped from the wire this phase, the column at phase 7).
        credentials = Credentials.list_visitor_credentials(visitor.id)

        network_triples =
          Enum.map(credentials, fn cred ->
            {cred.network, Networks.resolve_network_nick({:visitor, visitor.id}, cred), cred}
          end)

        render(conn, :index, networks: {:visitor, network_triples})
    end
  end

  @doc """
  `PATCH /networks/:network_id` — T32 connection_state transition.

  Accepts `{connection_state: "parked" | "connected", reason: string|nil}`.
  `:failed` is server-set only — returns 400 to the caller.

  #211 phase 6 — subject-agnostic (ruling D): BOTH users and visitors
  park/reconnect a network through this ONE verb. The `ResolveNetwork`
  plug already gated ownership (user → credential, visitor → credential),
  so `conn.assigns.network` is the caller's own network and
  `conn.assigns.current_subject` names who. The visitor
  disconnect/reconnect `POST /session/{disconnect,reconnect}` pair is
  RETIRED in favor of this — visitors are now equal to users on the
  connection-state surface.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :forbidden | :not_found | :not_connected}
  def update(conn, params) do
    with {:ok, target_state} <- parse_connection_state(params),
         {:ok, reason} <- parse_reason(params),
         {:ok, credential} <-
           fetch_credential(conn.assigns.current_subject, conn.assigns.network),
         {:ok, updated_cred} <-
           apply_transition(conn, conn.assigns.current_subject, credential, target_state, reason) do
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `PATCH /networks/:network_id/identity` — #211 phase 6 (ruling E, subsumes
  original #211): per-network IRC identity edit (`nick` + `ident` +
  `realname`) for BOTH subjects, live-applied via an internal reconnect.

  Identity is per-`(subject, network)` credential (the same nick may be
  in use on other networks), so this edits ONE network's credential. The
  `ResolveNetwork` plug asserts ownership (a caller with no credential on
  the network 404s). On success the upstream is RE-REGISTERED so the new
  ident/realname/nick take effect: ident/realname ride the once-only USER
  line (no live verb), so applying to a live session means a bounce — via
  the shared `SpawnOrchestrator.reconnect/5` (phase 5), wrapped HERE in
  the web layer (never the Networks context — that closes the
  `Networks → SpawnOrchestrator → Admission → Networks` Boundary cycle,
  DESIGN_NOTES 2026-07-11). A parked/no-live-session edit persists only;
  the next spawn reads the row.

  #211 phase 7 — the per-network credential is the SINGLE identity write
  path for BOTH subjects. The phase-6 visitor primary-network scalar
  dual-write is GONE: the `visitors.nick`/`network_slug` scalars are
  dropped, and `find_or_provision_anon`'s login-lookup resolves
  credential-first (`resolve_identity_by_nick/2`, keyed on the credential's
  `(fold(nick), network_id)`), so there is no row scalar left to keep in
  sync.

  Body: `{nick?, ident?, realname?}` — all optional. 200 with the updated
  credential; 422 on validation (bad nick / folded-nick collision); 404
  if the credential vanished; 401 without a Bearer.
  """
  @spec identity(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def identity(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, attrs} <- parse_identity_attrs(params),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated_cred} <- Credentials.update_credential_identity(credential, attrs) do
      # #211 phase 7 — the visitor-row scalar dual-write is GONE: identity
      # lives ONLY on the `(subject, network)` credential now, and login
      # resolves it credential-first. The per-network door is the single
      # write path for BOTH subjects.
      :ok = live_apply_identity(subject, network, updated_cred)
      render(conn, :update, credential: updated_cred)
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

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

  # #211 phase 6 — subject-agnostic credential fetch. Both branches are
  # `WHERE <subject>_id ==` (subject-blind-safe): a user can't reach a
  # visitor credential and vice versa. `ResolveNetwork` already asserted
  # the caller owns a credential on this network, so a miss here is a
  # concurrent unbind, not an authz probe.
  @spec fetch_credential(GrappaWeb.Subject.t(), Grappa.Networks.Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  defp fetch_credential({:user, %User{} = user}, network),
    do: Credentials.get_credential(user, network)

  defp fetch_credential({:visitor, %Visitor{id: vid}}, %{id: nid}),
    do: Credentials.get_visitor_credential(vid, nid)

  # Dispatch to the right context fn based on the target state. Both
  # transitions are subject-agnostic since phase 6 — `Networks.disconnect/2`
  # + `Networks.connect/1` derive the subject from the credential's XOR FK.
  @spec apply_transition(
          Plug.Conn.t(),
          GrappaWeb.Subject.t(),
          Credential.t(),
          Credential.connection_state(),
          String.t() | nil
        ) :: {:ok, Credential.t()} | {:error, atom()}
  defp apply_transition(_, _, credential, :parked, reason) do
    Networks.disconnect(credential, reason || "user-disconnect")
  end

  defp apply_transition(conn, subject, credential, :connected, _) do
    # U-0 stop-swallow fix (2026-05-16): spawn FIRST against the
    # parked credential, THEN commit the DB transition to `:connected`
    # only on spawn success. Pre-U-0, `Networks.connect/1` committed
    # first and `spawn_session_after_connect/3` swallowed every error
    # — cap-saturated PATCH /connect returned 200 OK with row at
    # `:connected` while no Session.Server was running, and subsequent
    # `POST /messages` 404'd silently. Per CLAUDE.md "REST is for
    # resources" + the no-silent-drops cluster lesson, the failure
    # must surface honestly at the REST boundary.
    #
    # **Concurrent-PATCH safety**: two simultaneous PATCH /connect on
    # the same parked credential are benign. SpawnOrchestrator.spawn/4
    # dedupes via `:already_started` (second request gets the live
    # pid, no second Session.Server); `Networks.connect/1` short-
    # circuits on `:connected` (second request's DB write is a no-op +
    # idempotent broadcast). No orphan process, no DB drift. Cic
    # tolerates the duplicate broadcast since `connection_state_changed`
    # is idempotent at the wire-edge.
    with {:ok, plan} <- resolve_plan(subject, credential, conn.assigns.network),
         {:ok, _} <- orchestrate_spawn(conn, subject, credential, plan),
         {:ok, updated_cred} <- Networks.connect(credential) do
      {:ok, updated_cred}
    end
  end

  # Resolve a `SessionPlan` from the credential. Subject-polymorphic:
  # the user resolver reads `Accounts.get_user!`, the visitor resolver
  # reads the `%Visitor{}` identity — routing a visitor through the user
  # resolver would crash on `Accounts.get_user!(nil)` (the phase-1
  # subject-blind-reader class). Returns a typed `:resolve_failed` on
  # failure so the controller surfaces it via FallbackController.
  @spec resolve_plan(GrappaWeb.Subject.t(), Credential.t(), Grappa.Networks.Network.t()) ::
          {:ok, Session.start_opts()} | {:error, :resolve_failed}
  defp resolve_plan({:user, %User{id: user_id}}, credential, _) do
    case SessionPlan.resolve(credential) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("PATCH /connect: session plan resolve failed",
          user: user_id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  defp resolve_plan({:visitor, %Visitor{} = visitor}, _, network) do
    # The visitor resolver is network-explicit (phase 4c) — a
    # multi-network visitor resolves the RIGHT network's plan, not the
    # (retired) singular `network_slug`. The `ResolveNetwork` plug
    # assigned `conn.assigns.network`.
    case Grappa.Visitors.SessionPlan.resolve(visitor, network) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("PATCH /connect: visitor session plan resolve failed",
          visitor_id: visitor.id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  # Call the orchestrator with the cred's network_id + computed plan +
  # capacity inputs. Subject-polymorphic (phase 6): the flow discriminant
  # is `:patch_network_connect` for users, `:visitor_reconnect` for
  # visitors (so the #171 per-IP cap tags the right subject_kind); the
  # `requesting_subject` self-exclusion keeps the caller's own live
  # browser session from counting against the cap on the respawn. Returns
  # the orchestrator's typed error atom verbatim so FallbackController's
  # existing T31 clauses pick up the 503 mapping unchanged.
  @spec orchestrate_spawn(
          Plug.Conn.t(),
          GrappaWeb.Subject.t(),
          Credential.t(),
          Session.start_opts()
        ) :: {:ok, pid()} | {:error, term()}
  defp orchestrate_spawn(conn, subject, credential, plan) do
    network_id = credential.network_id
    session_subject = to_session_subject(subject)

    capacity_input = %{
      network_id: network_id,
      # #171: raw conn here (no pre-formatted input.ip like login has), so
      # format through the canonical `RemoteIP.format/1` — the SAME
      # formatter user login stores in accounts_sessions.ip, or the per-IP
      # count would silently miss the stored rows.
      source_ip: GrappaWeb.RemoteIP.format(conn),
      flow: connect_flow(subject),
      # UX-5 bucket BC (2026-05-19): the requesting subject IS the subject
      # the spawn is for. Self-exclusion in the per-IP cap keeps it from
      # counting the caller's own active browser accounts_session against
      # them on the T32 park → /connect respawn path.
      requesting_subject: session_subject
    }

    case Grappa.SpawnOrchestrator.spawn(session_subject, network_id, plan, capacity_input) do
      {:ok, :spawned, pid} ->
        {:ok, pid}

      {:ok, :already_started, pid} ->
        {:ok, pid}

      {:ok, :ignored} ->
        # `Session.Server.init/1` short-circuited because the
        # credential row was unbound between this controller's
        # admission check and the spawn. Surface as :not_found so the
        # operator sees the same `404` a missing credential would give.
        Logger.warning(
          "PATCH /connect: subject row gone mid-spawn #{inspect(session_subject)}",
          network_id: network_id
        )

        {:error, :not_found}

      {:error, reason} = err ->
        Logger.warning(
          "PATCH /connect: session spawn rejected #{inspect(session_subject)}",
          network_id: network_id,
          error: inspect(reason)
        )

        err
    end
  end

  @spec to_session_subject(GrappaWeb.Subject.t()) :: Session.subject()
  defp to_session_subject({:user, %User{id: id}}), do: {:user, id}
  defp to_session_subject({:visitor, %Visitor{id: id}}), do: {:visitor, id}

  # U-2: the network-total cap atom is subject-keyed via the flow. A
  # user connect is `:patch_network_connect`; a visitor connect reuses
  # the `:visitor_reconnect` flow (subject_kind :visitor) so the cap +
  # circuit gate the right pool.
  @spec connect_flow(GrappaWeb.Subject.t()) :: Grappa.Admission.flow()
  defp connect_flow({:user, _}), do: :patch_network_connect
  defp connect_flow({:visitor, _}), do: :visitor_reconnect

  # ---------------------------------------------------------------------------
  # PATCH /networks/:network_id/identity helpers (#211 phase 6, ruling E)
  # ---------------------------------------------------------------------------

  # Whitelist the three identity fields from the body. A key the caller
  # OMITS is left out (no clobber); a present `""` passes through (a
  # deliberate "clear to default" — the SessionPlan effective_* fallback
  # applies). #211 phase 7 — this is the CANONICAL identity edit surface
  # for both subjects (the retired `PATCH /me/identity` / `identity_attrs/1`
  # is gone). `nil` values are rejected (a JSON null for an identity field
  # is malformed). Empty map is a valid no-op.
  @spec parse_identity_attrs(map()) ::
          {:ok, %{optional(:nick) => String.t(), optional(:ident) => String.t(), optional(:realname) => String.t()}}
          | {:error, :bad_request}
  defp parse_identity_attrs(params) do
    Enum.reduce_while([{"nick", :nick}, {"ident", :ident}, {"realname", :realname}], {:ok, %{}}, fn
      {string_key, atom_key}, {:ok, acc} ->
        case Map.fetch(params, string_key) do
          {:ok, v} when is_binary(v) -> {:cont, {:ok, Map.put(acc, atom_key, v)}}
          {:ok, _} -> {:halt, {:error, :bad_request}}
          :error -> {:cont, {:ok, acc}}
        end
    end)
  end

  # Web-layer reconnect wrapper (NEVER the Networks context — Boundary
  # cycle). Resolves the subject's plan for the network + bounces the
  # LIVE session via `SpawnOrchestrator.reconnect/5` so the new
  # ident/realname/nick re-register on a fresh USER line. The `whereis`
  # guard keeps it to an already-live session (a parked/no-session edit
  # persists only). Failures are logged, never surfaced — the identity is
  # saved regardless of the bounce (mirrors `Visitors.maybe_reconnect_after_identity/1`).
  @spec live_apply_identity(GrappaWeb.Subject.t(), Grappa.Networks.Network.t(), Credential.t()) ::
          :ok
  defp live_apply_identity(subject, %{id: network_id} = network, credential) do
    session_subject = to_session_subject(subject)

    with pid when is_pid(pid) <- Session.whereis(session_subject, network_id),
         {:ok, plan} <- resolve_plan(subject, credential, network) do
      case Grappa.SpawnOrchestrator.reconnect(
             session_subject,
             network_id,
             plan,
             identity_capacity_input(subject, network_id),
             "applying identity change"
           ) do
        {:ok, _, _} ->
          :ok

        other ->
          Logger.warning(
            "PATCH /identity: reconnect failed (identity persisted) #{inspect(session_subject)}",
            network_id: network_id,
            error: inspect(other)
          )

          :ok
      end
    else
      # No live session (parked / never connected) or unresolvable plan —
      # persist-only; the next spawn reads the new identity.
      _ -> :ok
    end
  end

  # Mirror of `orchestrate_spawn/4`'s capacity_input for the identity
  # bounce. `requesting_subject` self-excludes the caller's own session
  # from the per-IP cap on the respawn.
  @spec identity_capacity_input(GrappaWeb.Subject.t(), integer()) :: Grappa.Admission.capacity_input()
  defp identity_capacity_input(subject, network_id) do
    session_subject = to_session_subject(subject)

    %{
      network_id: network_id,
      source_ip: nil,
      flow: connect_flow(subject),
      requesting_subject: session_subject
    }
  end
end
