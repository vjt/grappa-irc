defmodule Grappa.Visitors.Login do
  @moduledoc """
  Synchronous login orchestrator for visitor self-service —
  implements the W10/W11/W12/W13 privacy decision tree (cluster
  visitor-auth, S5 amendment).

  Flow:

    1. Validate nick shape (delegates to
       `Grappa.Auth.IdentifierClassifier`).
    2. Resolve the target visitor `Network` from the RUNTIME
       `networks.visitor_enabled` allowlist (#211 phase 3 — replaces
       the compile-time `:visitor_network` pin). An explicit `:network`
       slug in the input must be `visitor_enabled` (else
       `:network_not_visitor_enabled` / `:network_unconfigured`); no
       slug defaults to the SOLE enabled network (`:network_ambiguous`
       when more than one is enabled and no slug is given — cic sends a
       slug once the phase-6 picker ships).
    3. Look up an existing `Visitor` row by `(nick, network_slug)`.
    4. Branch on `(visitor existence × the Credential's password_encrypted)`.
       #211 phase 4a: the registered-vs-anon discriminator + the password
       gate read the visitor's `(visitor_id, network_id)` **Credential**
       secret (via the self-healing `Visitors.resolve_credential/2`), NOT
       the `visitors.password_encrypted` scalar — the credential is the
       read-of-record for auth just as it already is for session identity
       (phase 3). Phase 7 drops the visitor scalar; reading the Credential
       here makes that a pure column-drop, not an auth-logic change.

       * **Case 1 — no row.** Check per-(client, network) cap via
         `Grappa.Admission.check_capacity/1` (T31), verify CAPTCHA,
         provision a fresh anon visitor, spawn `Session.Server` with
         `notify_pid: self()` + `notify_ref: ref`, block on
         `{:session_ready, ref}`. On any spawn failure the
         just-created anon row is purged so a retry starts clean.
         On success, `NetworkCircuit.record_success/1` clears prior
         failure state; on spawn failure, `NetworkCircuit.record_failure/1`
         bumps the circuit. Mint an `Accounts.Session` and return
         `{:ok, %{visitor, token}}`.

       * **Case 2 — registered (Credential `password_encrypted` set).**
         Require password FIRST (constant-time compare via
         `Plug.Crypto.secure_compare/2` against the CREDENTIAL secret, to
         avoid timing oracles), then branch on whether a live
         `Session.Server` already serves this identity (`Session.whereis/2`):

           - **Live session → ATTACH (#117).** Mint a fresh
             `accounts_sessions` row and return — the new client rides
             the running session via the visitor's user-rooted PubSub
             topics (true bouncer: one session, N clients). NO preempt,
             NO respawn (so #116 autojoin is not re-run), NO token
             revocation (other attached clients stay alive), NO capacity
             gate (nothing is spawned). Same mechanic as share-token
             consume and the mode1 user-login path.

           - **No live session → preempt + respawn (unchanged).** Check
             capacity (the SPAWN gate), then revoke prior
             `accounts_sessions` rows (`Accounts.revoke_sessions_for_visitor/1`,
             they pointed at a now-dead session), `Visitors.purge_if_anon/1`
             per W11 (no-op for registered but mirror-symmetric),
             `Session.stop_session/2` (idempotent), `Session.Backoff.reset/2`
             (clear crash-backoff so an explicit re-login isn't penalised),
             respawn fresh Session.Server, `NetworkCircuit.record_success/1`
             on welcome, mint a fresh Accounts.Session.

         On the respawn path the NickServ `IDENTIFY` is emitted by the
         AuthFSM at 001 for the `:nickserv_identify` plan — the single
         IDENTIFY site (see `Grappa.IRC.AuthFSM.maybe_nickserv_identify/1`,
         staged for the +r MODE observer via
         `Session.Server.maybe_stage_pending_password/1`). Login does NOT
         send a second one post-readiness (#27): a duplicate IDENTIFY
         made NickServ reply with the "identified" NOTICE twice.

       * **Case 3 — anon (Credential `password_encrypted` nil).** Check
         capacity, then require a valid bearer token that resolves
         (via `Accounts.authenticate/1`) to THIS visitor's id. On
         match: rotate token (revoke old, mint new), keep the live
         Session.Server (no preemption — same client). On absent /
         wrong token: `:anon_collision`. The original holder must
         wait for natural expiration (W9) to free the nick.

  Synchronous probe budget split (U-2 UD7): the pre-U-2 single
  `:login_probe_timeout_ms` (3s) covered the entire flow and exhausted
  before Bahamut's rDNS lookup could complete in the wild. Post-U-2
  three configurable budgets — `:login_connect_timeout_ms` (3s default,
  TCP/TLS phase), `:login_welcome_timeout_ms` (30s default, NICK/USER
  → 001 phase), `:login_probe_timeout_ms` (35s default, outer guard) —
  produce typed errors `:connect_timeout` / `:welcome_timeout` /
  `:probe_timeout` so the cic banner + Retry-After hints differ per
  failure mode. Test paths shrink each via `:login_connect_timeout_ms`
  / `:login_welcome_timeout_ms` opts.
  """

  alias Grappa.{Accounts, Networks, Session, Visitors}
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Networks.Credential
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.{SessionPlan, Visitor}

  require Logger

  # #211 phase 3 — the compile-time `:visitor_network` pin is GONE.
  # Which networks accept visitors is now the runtime DB flag
  # `networks.visitor_enabled`, read at login time via
  # `Networks.list_visitor_enabled/0` /
  # `Networks.get_visitor_enabled_network_by_slug/1` (admin-togglable
  # without a restart). `Application.compile_env!(:grappa,
  # :visitor_network)` and the `visitor_network/0` helper are removed.

  # U-2 (UD7): split single `:login_probe_timeout_ms` budget into two
  # inner timeouts (connect / welcome) + one outer guard. Pre-U-2 a 3s
  # budget covered the ENTIRE login flow from TCP `connect` through TLS
  # handshake through NICK/USER through `RPL_WELCOME` (001) — the 3s
  # exhausted before 001 arrived under Bahamut rDNS-blocking (5-20s
  # observed). Inner budgets surface distinct typed errors:
  # `:connect_timeout` (TCP/TLS phase, 3s), `:welcome_timeout`
  # (NICK/USER → 001 phase, 30s). Outer `:probe_timeout` is an
  # assertion catchall — it should never fire when the inner budgets
  # are honored and the receives are wired correctly; if it does, the
  # budget arithmetic is wrong.
  @login_connect_timeout_ms Application.compile_env(
                              :grappa,
                              [:admission, :login_connect_timeout_ms],
                              3_000
                            )
  @login_welcome_timeout_ms Application.compile_env(
                              :grappa,
                              [:admission, :login_welcome_timeout_ms],
                              30_000
                            )
  @login_probe_timeout_ms Application.compile_env(
                            :grappa,
                            [:admission, :login_probe_timeout_ms],
                            35_000
                          )

  @type input :: %{
          required(:nick) => String.t(),
          required(:password) => String.t() | nil,
          required(:ident) => String.t() | nil,
          required(:realname) => String.t() | nil,
          required(:ip) => String.t() | nil,
          required(:user_agent) => String.t() | nil,
          required(:token) => String.t() | nil,
          required(:captcha_token) => String.t() | nil,
          required(:client_id) => Grappa.ClientId.t() | nil,
          # #211 phase 3 — optional target network slug. Present → must be
          # `visitor_enabled` (else `:network_not_visitor_enabled`).
          # Absent → default to the SOLE visitor-enabled network
          # (backward-compatible with the pre-phase-3 single-network cic);
          # zero enabled → `:network_unconfigured`; more than one enabled
          # with no slug → `:network_ambiguous` (cic gains the picker in
          # phase 6 before a 2nd network is expected).
          optional(:network) => String.t() | nil
        }

  @type result :: %{visitor: Visitor.t(), token: Ecto.UUID.t()}

  @type login_error ::
          :malformed_nick
          | :malformed_ident
          | :ip_cap_exceeded
          | :visitor_cap_exceeded
          | :user_cap_exceeded
          | {:network_circuit_open, non_neg_integer()}
          | :captcha_required
          | :captcha_failed
          | :captcha_provider_unavailable
          | :upstream_unreachable
          | :nick_in_use
          | :connect_timeout
          | :welcome_timeout
          | :probe_timeout
          | :no_server
          | :network_unconfigured
          | :network_not_visitor_enabled
          | :network_ambiguous
          | :password_required
          | :password_mismatch
          | :anon_collision

  @doc """
  Run the synchronous login flow against the configured visitor
  network. `input` carries the request fields (`nick`, `password`,
  `ip`, `user_agent`, `token`, `captcha_token`, `client_id`). `opts`
  accepts `:login_connect_timeout_ms` + `:login_welcome_timeout_ms`
  for tests that need to shrink the probe budgets — production callers
  pass `[]`.

  Returns `{:ok, %{visitor, token}}` on success or
  `{:error, login_error()}` with the failure reason.
  """
  @spec login(input(), keyword()) :: {:ok, result()} | {:error, login_error()}
  def login(
        %{
          nick: _,
          password: _,
          ident: _,
          realname: _,
          ip: _,
          user_agent: _,
          token: _,
          captcha_token: _,
          client_id: _
        } = input,
        opts
      )
      when is_list(opts) do
    timeouts = %{
      connect_ms: Keyword.get(opts, :login_connect_timeout_ms, @login_connect_timeout_ms),
      welcome_ms: Keyword.get(opts, :login_welcome_timeout_ms, @login_welcome_timeout_ms),
      probe_ms: Keyword.get(opts, :login_probe_timeout_ms, @login_probe_timeout_ms)
    }

    with :ok <- validate_nick(input.nick),
         {:ok, network} <- resolve_visitor_network(Map.get(input, :network)) do
      input.nick
      |> lookup_visitor(network.slug)
      |> dispatch(input, network, timeouts)
    end
  end

  defp validate_nick(nick) do
    case IdentifierClassifier.classify(nick) do
      {:nick, _} -> :ok
      _ -> {:error, :malformed_nick}
    end
  end

  # #211 phase 3 — resolve the target visitor network from the runtime
  # `networks.visitor_enabled` allowlist (replacing the compile-time
  # `:visitor_network` pin).
  #
  #   * an explicit slug → must be `visitor_enabled` (the attach gate):
  #     unknown → `:network_unconfigured`, exists-but-disabled →
  #     `:network_not_visitor_enabled`.
  #   * no slug (today's cic) → default to the SOLE enabled network.
  #     Zero enabled → `:network_unconfigured` (the operator has not
  #     opted any network in / the `azzurra` continuity seed did not
  #     run). More than one enabled → `:network_ambiguous` (cic sends a
  #     slug once the phase-6 picker ships; until then a single enabled
  #     network is the expected prod shape).
  @spec resolve_visitor_network(String.t() | nil) ::
          {:ok, Networks.Network.t()}
          | {:error, :network_unconfigured | :network_not_visitor_enabled | :network_ambiguous}
  defp resolve_visitor_network(slug) when is_binary(slug) and slug != "" do
    case Networks.get_visitor_enabled_network_by_slug(slug) do
      {:ok, %Networks.Network{} = network} -> {:ok, network}
      {:error, :not_found} -> {:error, :network_unconfigured}
      {:error, :not_visitor_enabled} -> {:error, :network_not_visitor_enabled}
    end
  end

  defp resolve_visitor_network(_) do
    case Networks.list_visitor_enabled() do
      [%Networks.Network{} = only] -> {:ok, only}
      [] -> {:error, :network_unconfigured}
      [_ | _] -> {:error, :network_ambiguous}
    end
  end

  # Delegates to the context's rfc1459-folded lookup (GH #121) so a
  # different-case reconnect resolves to the SAME visitor.id — which is
  # what the #117 attach-to-existing-session path keys on, reattaching
  # instead of provisioning a duplicate.
  defp lookup_visitor(nick, slug) do
    Visitors.get_by_nick_and_network(nick, slug)
  end

  # Case 1 — provision new anon
  defp dispatch(nil, input, network, timeouts) do
    capacity_input = %{
      network_id: network.id,
      # #171: source IP is the per-actor cap key — anon logins have no
      # stable client identity, so the flood handle is the IP. Same value
      # login writes to accounts_sessions.ip below.
      source_ip: input.ip,
      flow: :login_fresh,
      # No prior subject — fresh anon provision (UX-5 bucket BC).
      requesting_subject: nil
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- Grappa.Admission.verify_captcha(input.captcha_token, input.ip),
         {:ok, visitor} <-
           Visitors.find_or_provision_anon(input.nick, network.slug, input.ip) do
      case continue_case_1(visitor, network, input, timeouts) do
        {:ok, _} = ok ->
          :ok = NetworkCircuit.record_success(network.id)
          ok

        {:error, _} = err ->
          :ok = NetworkCircuit.record_failure(network.id)
          # Purge the just-provisioned anon row so a retry starts
          # clean. purge_if_anon/1 short-circuits on registered rows
          # (which can't be reached in case 1 anyway) — the call is
          # safe even on the can't-happen case-2/3-mid-race edge.
          # This also covers a `:malformed_ident` from apply_login_identity
          # (now inside continue_case_1): a bad login-Advanced ident must
          # not leave the fresh anon row squatting the nick.
          :ok = Visitors.purge_if_anon(visitor.id)
          err
      end
    end
  end

  # Case 2/3 — existing visitor row. #211 phase 4a: the registered-vs-anon
  # discriminator AND the password gate read the visitor's
  # `(visitor_id, network_id)` **Credential** secret — the phase-3
  # read-of-record for session identity, now also the read-of-record for
  # AUTH — NOT the `visitors.password_encrypted` scalar (phase 7 drops the
  # scalar; reading the Credential here makes that a pure column-drop, not
  # an auth-logic change). `Visitors.resolve_credential/2` is the
  # self-healing reader (mirrors `Visitors.SessionPlan`): a drifted
  # credential is rebuilt from the visitor row before the compare, so the
  # compared bytes are the visitor's current secret. Behavior-neutral today
  # — phase-3 dual-write keeps `visitor.password_encrypted ==
  # credential.password_encrypted`.
  defp dispatch(%Visitor{} = visitor, input, network, timeouts) do
    case Visitors.resolve_credential(visitor, network.id) do
      {:ok, %Credential{password_encrypted: pwd}} when is_binary(pwd) ->
        dispatch_registered(visitor, pwd, input, network, timeouts)

      {:ok, %Credential{password_encrypted: nil}} ->
        dispatch_anon(visitor, input, network)

      {:error, :not_found} ->
        # The credential can't be built from the visitor row (its changeset
        # rejected the derived attrs — should not happen for a well-formed
        # row). Same "subject no longer viable" surface the login
        # probe-connect path uses for a vanished row / failed resolve.
        {:error, :upstream_unreachable}
    end
  end

  # Case 2 — registered, password gate. `pwd` is the CREDENTIAL secret
  # (resolved by dispatch/4 above), not the visitor scalar.
  defp dispatch_registered(%Visitor{} = visitor, pwd, input, network, timeouts)
       when is_binary(pwd) do
    # Password is the auth gate — prove identity BEFORE deciding attach vs
    # respawn (and before any capacity/spawn work, so a wrong-password attempt
    # leaks no cap/circuit state).
    with :ok <- check_password(input.password, pwd) do
      # #117 — a registered visitor IS a stable identity (`visitor.id` is per
      # `(nick, network_slug)`), so the same NickServ account re-resolves to the
      # one session key. If that session is already live, ATTACH the new login
      # to it (true bouncer: one session, N clients) instead of preempt+respawn.
      # `Session.whereis/2` is the derived live-pid truth — no parallel state.
      case Session.whereis({:visitor, visitor.id}, network.id) do
        pid when is_pid(pid) ->
          attach_to_existing(visitor, input, pid)

        nil ->
          # No live session for the identity → fall through to the fresh
          # new-session path (unchanged). Extracted to keep this clause at a
          # sane nesting depth.
          respawn_path(visitor, network, input, timeouts)
      end
    end
  end

  # Case 3 — anon (credential carries no secret), token gate.
  defp dispatch_anon(%Visitor{id: visitor_id} = visitor, input, network) do
    capacity_input = %{
      network_id: network.id,
      source_ip: input.ip,
      flow: :login_existing,
      requesting_subject: {:visitor, visitor_id}
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- check_anon_token(input.token, visitor.id) do
      rotate_token(visitor, input)
    end
  end

  # #152 — persist the login-Advanced ident/realname onto the freshly
  # provisioned anon row BEFORE the spawn, so the plan resolver reads
  # them and the FIRST USER line at registration carries the identity
  # (no reconnect needed at initial login). Reuses the schema's
  # `identity_changeset/2` (tilde-strip + shape guard) via
  # `Visitors.update_identity/2` — but this is a NOT-yet-live row, so
  # that call takes the persist-only branch (no session to reconnect).
  # A bad ident surfaces as `:malformed_ident` so the login 400s (the
  # caller purges the fresh row on this error, same as a spawn failure).
  # No-op when neither field is set (guest / plain login).
  @spec apply_login_identity(Visitor.t(), input()) ::
          {:ok, Visitor.t()} | {:error, :malformed_ident | :upstream_unreachable}
  defp apply_login_identity(visitor, input) do
    identity = login_identity_attrs(input)

    if identity == %{} do
      {:ok, visitor}
    else
      case Visitors.update_identity(visitor, identity) do
        {:ok, updated} -> {:ok, updated}
        {:error, %Ecto.Changeset{}} -> {:error, :malformed_ident}
        # A concurrent delete of the just-provisioned row (services
        # enforce-rename race, operator delete) is NOT a bad ident — map
        # it to the same surface the spawn `:ignore` path uses so the user
        # isn't told to fix a well-formed ident.
        {:error, :not_found} -> {:error, :upstream_unreachable}
      end
    end
  end

  # Build the identity attrs map from the login input, omitting keys the
  # user left blank so a plain/guest login is a no-op (and never clobbers
  # the visitor defaults).
  @spec login_identity_attrs(input()) :: map()
  defp login_identity_attrs(input) do
    %{}
    |> put_if_present(:ident, input.ident)
    |> put_if_present(:realname, input.realname)
  end

  defp put_if_present(map, _, nil), do: map
  defp put_if_present(map, _, ""), do: map
  defp put_if_present(map, key, value) when is_binary(value), do: Map.put(map, key, value)

  # Case 2 fresh-spawn path (no live session for the identity). Capacity gates
  # the SPAWN here; the attach path is deliberately ungated — it spawns nothing,
  # so the network-total / circuit caps (which gate dialing a new upstream) must
  # not block a returning identity whose session already exists. UX-5 bucket BC:
  # `requesting_subject` excludes the visitor's own pre-existing accounts_session
  # from the cap on respawn from the same device.
  defp respawn_path(%Visitor{id: visitor_id} = visitor, network, input, timeouts) do
    capacity_input = %{
      network_id: network.id,
      source_ip: input.ip,
      flow: :login_existing,
      requesting_subject: {:visitor, visitor_id}
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input) do
      preempt_and_respawn(visitor, network, input, timeouts)
    end
  end

  # #117 attach: an existing live `Session.Server` already serves this identity.
  # Mint a fresh `accounts_sessions` row for the new client and return — the
  # client subscribes to the visitor's user-rooted PubSub topics and rides the
  # running session (same mechanic as share-token consume and the mode1 user
  # login). NO preempt, NO respawn (so #116 autojoin is not re-run), NO token
  # revocation (other attached clients stay alive), NO capacity gate (no spawn).
  defp attach_to_existing(%Visitor{} = visitor, input, pid) do
    Logger.info("login: attached to existing live session (visitor=#{visitor.id} pid=#{inspect(pid)})")

    issue_token(visitor, input)
  end

  defp continue_case_1(visitor, network, input, timeouts) do
    # apply_login_identity runs INSIDE this fn (not the dispatch/4 `with`
    # head) so a `:malformed_ident` flows through dispatch/4's error branch
    # that purges the just-provisioned anon row — otherwise a bad
    # login-Advanced ident leaves the row squatting the nick until the TTL
    # reaper. Persist BEFORE spawn so the first USER carries the identity.
    with {:ok, visitor} <- apply_login_identity(visitor, input),
         {:ok, _} <- spawn_and_await(visitor, network, input.password, timeouts) do
      issue_token(visitor, input)
    end
  end

  defp check_password(nil, _), do: {:error, :password_required}

  defp check_password(provided, encrypted)
       when is_binary(provided) and is_binary(encrypted) do
    if Plug.Crypto.secure_compare(provided, encrypted) do
      :ok
    else
      {:error, :password_mismatch}
    end
  end

  defp check_anon_token(nil, _), do: {:error, :anon_collision}

  defp check_anon_token(token, visitor_id) when is_binary(token) do
    case Accounts.authenticate(token) do
      {:ok, %{visitor_id: ^visitor_id}} -> :ok
      _ -> {:error, :anon_collision}
    end
  end

  defp preempt_and_respawn(visitor, network, input, timeouts) do
    :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
    :ok = Visitors.purge_if_anon(visitor.id)
    :ok = Session.stop_session({:visitor, visitor.id}, network.id, "session replaced")
    :ok = Backoff.reset({:visitor, visitor.id}, network.id)

    # Registered visitors keep their row-resolved `:nickserv_identify`
    # plan (password from the EncryptedBinary roundtrip) — pass `nil` for
    # the login-form password so `SessionPlan.with_login_identify/2`
    # no-ops and the resolved plan stays intact.
    with {:ok, _} <- spawn_and_await(visitor, network, nil, timeouts) do
      :ok = NetworkCircuit.record_success(network.id)
      issue_token(visitor, input)
    end
  end

  defp rotate_token(visitor, input) do
    :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
    issue_token(visitor, input)
  end

  defp spawn_and_await(visitor, network, login_password, timeouts) do
    case SessionPlan.resolve(visitor) do
      {:ok, plan} ->
        # Fresh-visitor first-login IDENTIFY policy (case 1 only — case 2
        # passes `login_password: nil`, case 3 doesn't respawn). A fresh
        # visitor resolves to an anon plan (`auth_method: :none`), so a
        # first-time NickServ registration would otherwise hang on the
        # fragile manual-identify → +r rendezvous and lose the race when
        # services enforce-rename a protected nick to `Guest…` before the
        # user identifies. When the login form carries a password we force
        # the plan to identify at 001 (ahead of the enforce timer) via
        # `SessionPlan.with_login_identify/2`, which owns the
        # refresh-shape mechanics that keep the override alive across
        # `Session.Server.init/1`'s DB-wins re-resolve. `+r` then commits
        # the password to the DB (`commit_password/2`) and later
        # re-resolves carry `:nickserv_identify` naturally.
        #
        # A WRONG password never commits (no `+r`): the row stays anon and
        # the wrong IDENTIFY is re-sent on every crash-`:transient`
        # restart — the fresh path has no stored password to compare
        # against, unlike case 2's `secure_compare` — until the user
        # re-logs-in with the correct password, which re-enters this same
        # path because the row is still anon.
        plan = SessionPlan.with_login_identify(plan, login_password)
        ref = make_ref()
        plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})

        case Session.start_session({:visitor, visitor.id}, network.id, plan_with_notify) do
          {:ok, pid} ->
            wait_for_ready(visitor.id, network.id, pid, ref, timeouts)

          {:error, {:already_started, pid}} ->
            {:ok, pid}

          :ignore ->
            # `Session.Server.init/1` short-circuited because the
            # visitor row is gone (operator-driven `Visitors.delete/1`
            # raced this login). Surface as upstream-unreachable; the
            # caller is the synchronous login probe-connect path and
            # has no use for further differentiation.
            {:error, :upstream_unreachable}

          {:error, _} ->
            {:error, :upstream_unreachable}
        end

      {:error, reason} when reason in [:no_server, :network_unconfigured] ->
        {:error, reason}
    end
  end

  # U-2 (UD7): two-phase nested receive. Phase 1 awaits the
  # `{:session_phase, ref, :connected}` signal that `Session.Server`
  # re-fires when `IRC.Client` reports TCP/TLS handshake success
  # (`:irc_connected`). Phase 2 awaits `{:session_ready, ref}` at 001
  # RPL_WELCOME. Each phase carries an independent timeout budget +
  # surfaces a distinct typed error. `:DOWN` short-circuits both
  # phases as `:upstream_unreachable` (the spawned Session.Server
  # crashed before it could complete the phase). On any timeout we
  # tear the session down explicitly so the `:transient` restart loop
  # stops (cluster-cascading bad otherwise — pre-fix would have
  # rapidly restarted against the same broken upstream).
  defp wait_for_ready(visitor_id, network_id, pid, ref, timeouts) do
    monitor_ref = Process.monitor(pid)

    case wait_for_connected(pid, ref, monitor_ref, timeouts.connect_ms) do
      :ok ->
        wait_for_welcomed(visitor_id, network_id, pid, ref, monitor_ref, timeouts.welcome_ms)

      {:error, reason} ->
        tear_down(visitor_id, network_id, monitor_ref, reason)
    end
  end

  defp wait_for_connected(pid, ref, monitor_ref, timeout) do
    receive do
      {:session_phase, ^ref, :connected} ->
        :ok

      {:DOWN, ^monitor_ref, :process, ^pid, reason} ->
        {:error, {:down, classify_down(reason)}}
    after
      timeout ->
        {:error, :connect_timeout}
    end
  end

  defp wait_for_welcomed(visitor_id, network_id, pid, ref, monitor_ref, timeout) do
    receive do
      {:session_ready, ^ref} ->
        Process.demonitor(monitor_ref, [:flush])
        {:ok, pid}

      {:DOWN, ^monitor_ref, :process, ^pid, reason} ->
        Session.stop_session({:visitor, visitor_id}, network_id)
        {:error, classify_down(reason)}
    after
      timeout ->
        tear_down(visitor_id, network_id, monitor_ref, :welcome_timeout)
    end
  end

  # #40: a fresh-login / anon visitor who picks a nick already taken on the
  # upstream gets a 433 ERR_NICKNAMEINUSE during registration. AuthFSM has
  # no recovery path for a passwordless session, so it stops the Client with
  # `{:nick_rejected, 433, _}`; Session.Server wraps the linked-exit as
  # `{:client_exit, _}` before propagating, which is the monitored DOWN
  # reason seen here. Surface it as `:nick_in_use` so the user gets the
  # actionable "pick another nick" copy instead of the generic
  # `:upstream_unreachable` / `:welcome_timeout`. 432 ERR_ERRONEUSNICKNAME is
  # deliberately NOT mapped — `validate_nick/1` already gates nick shape, so
  # a 432 means upstream-specific rules differ and the generic surface is
  # honest about "we couldn't tell you what's wrong with it."
  defp classify_down({:client_exit, {:nick_rejected, 433, _}}), do: :nick_in_use
  defp classify_down(_), do: :upstream_unreachable

  defp tear_down(visitor_id, network_id, monitor_ref, reason) do
    Process.demonitor(monitor_ref, [:flush])
    Session.stop_session({:visitor, visitor_id}, network_id)

    case reason do
      {:down, inner} when is_atom(inner) -> {:error, inner}
      atom when is_atom(atom) -> {:error, atom}
    end
  end

  defp issue_token(visitor, input) do
    {:ok, session} =
      Accounts.create_session(
        {:visitor, visitor.id},
        input.ip,
        input.user_agent,
        client_id: input.client_id
      )

    {:ok, %{visitor: visitor, token: session.id}}
  end
end
