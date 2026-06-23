defmodule Grappa.Visitors.Login do
  @moduledoc """
  Synchronous login orchestrator for visitor self-service —
  implements the W10/W11/W12/W13 privacy decision tree (cluster
  visitor-auth, S5 amendment).

  Flow:

    1. Validate nick shape (delegates to
       `Grappa.Auth.IdentifierClassifier`).
    2. Resolve the configured visitor `Network` row (compile-time
       slug via `Application.compile_env/3` → DB lookup; missing
       row surfaces as `:network_unconfigured`). Boot-time
       presence of the slug itself is asserted by
       `Grappa.Bootstrap` (Task 20 W7) — Login trusts the boot
       gate.
    3. Look up an existing `Visitor` row by `(nick, network_slug)`.
    4. Branch on `(visitor existence × password_encrypted)`:

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

       * **Case 2 — registered (`password_encrypted` set).**
         Check capacity, then require password. Constant-time compare
         via `Plug.Crypto.secure_compare/2` to avoid timing oracles.
         On match: revoke prior `accounts_sessions` rows
         (`Accounts.revoke_sessions_for_visitor/1`),
         `Visitors.purge_if_anon/1` per W11 (no-op for registered
         but mirror-symmetric with other deletion sites),
         `Session.stop_session/2` (idempotent),
         `Session.Backoff.reset/2` (clear crash-backoff from prior
         session so an explicit user re-login isn't penalised),
         respawn fresh Session.Server, `NetworkCircuit.record_success/1`
         on welcome, then mint a fresh Accounts.Session. The NickServ
         `IDENTIFY` is emitted by the AuthFSM at 001 for the
         `:nickserv_identify` plan — the single IDENTIFY site (see
         `Grappa.IRC.AuthFSM.maybe_nickserv_identify/1`, staged for the
         +r MODE observer via `Session.Server.maybe_stage_pending_password/1`).
         Login does NOT send a second one post-readiness (#27): a
         duplicate IDENTIFY made NickServ reply with the "identified"
         NOTICE twice.

       * **Case 3 — anon (`password_encrypted` nil).** Check
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

  alias Grappa.{Accounts, Networks, Repo, Session, Visitors}
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.{SessionPlan, Visitor}

  # B6.6 X3 (no-silent-drops 2026-05-14): bang form so a missing
  # `:visitor_network` config value crashes at compile time, not at
  # the first request. Mirrors auth_controller.ex:58, endpoint.ex:33,
  # admission.ex:73.
  @visitor_network Application.compile_env!(:grappa, :visitor_network)

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
          required(:ip) => String.t() | nil,
          required(:user_agent) => String.t() | nil,
          required(:token) => String.t() | nil,
          required(:captcha_token) => String.t() | nil,
          required(:client_id) => Grappa.ClientId.t() | nil
        }

  @type result :: %{visitor: Visitor.t(), token: Ecto.UUID.t()}

  @type login_error ::
          :malformed_nick
          | :client_cap_exceeded
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
        %{nick: _, password: _, ip: _, user_agent: _, token: _, captcha_token: _, client_id: _} =
          input,
        opts
      )
      when is_list(opts) do
    timeouts = %{
      connect_ms: Keyword.get(opts, :login_connect_timeout_ms, @login_connect_timeout_ms),
      welcome_ms: Keyword.get(opts, :login_welcome_timeout_ms, @login_welcome_timeout_ms),
      probe_ms: Keyword.get(opts, :login_probe_timeout_ms, @login_probe_timeout_ms)
    }

    with :ok <- validate_nick(input.nick),
         {:ok, network} <- visitor_network() do
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

  defp visitor_network do
    case Networks.get_network_by_slug(@visitor_network) do
      {:ok, %Networks.Network{} = network} -> {:ok, network}
      {:error, :not_found} -> {:error, :network_unconfigured}
    end
  end

  defp lookup_visitor(nick, slug) do
    Repo.get_by(Visitor, nick: nick, network_slug: slug)
  end

  # Case 1 — provision new anon
  defp dispatch(nil, input, network, timeouts) do
    capacity_input = %{
      network_id: network.id,
      client_id: input.client_id,
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
          :ok = Visitors.purge_if_anon(visitor.id)
          err
      end
    end
  end

  # Case 2 — registered, password gate
  defp dispatch(%Visitor{password_encrypted: pwd, id: visitor_id} = visitor, input, network, timeouts)
       when is_binary(pwd) do
    capacity_input = %{
      network_id: network.id,
      client_id: input.client_id,
      flow: :login_existing,
      # UX-5 bucket BC: the visitor IS the requesting subject; the cap
      # must not count their own pre-existing accounts_session against
      # them on respawn from the same device.
      requesting_subject: {:visitor, visitor_id}
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- check_password(input.password, pwd) do
      preempt_and_respawn(visitor, network, input, timeouts)
    end
  end

  # Case 3 — anon, token gate
  defp dispatch(%Visitor{password_encrypted: nil, id: visitor_id} = visitor, input, network, _) do
    capacity_input = %{
      network_id: network.id,
      client_id: input.client_id,
      flow: :login_existing,
      requesting_subject: {:visitor, visitor_id}
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- check_anon_token(input.token, visitor.id) do
      rotate_token(visitor, input)
    end
  end

  defp continue_case_1(visitor, network, input, timeouts) do
    with {:ok, _} <- spawn_and_await(visitor, network, timeouts) do
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

    with {:ok, _} <- spawn_and_await(visitor, network, timeouts) do
      :ok = NetworkCircuit.record_success(network.id)
      issue_token(visitor, input)
    end
  end

  defp rotate_token(visitor, input) do
    :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
    issue_token(visitor, input)
  end

  defp spawn_and_await(visitor, network, timeouts) do
    case SessionPlan.resolve(visitor) do
      {:ok, plan} ->
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
