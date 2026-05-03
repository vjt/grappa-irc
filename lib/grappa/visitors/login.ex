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
         on welcome, send `PRIVMSG NickServ :IDENTIFY <pwd>`
         post-readiness so NickServ + the +r MODE observer
         (Task 15) can reconfirm registration, then mint a fresh
         Accounts.Session.

       * **Case 3 — anon (`password_encrypted` nil).** Check
         capacity, then require a valid bearer token that resolves
         (via `Accounts.authenticate/1`) to THIS visitor's id. On
         match: rotate token (revoke old, mint new), keep the live
         Session.Server (no preemption — same client). On absent /
         wrong token: `:anon_collision`. The original holder must
         wait for natural expiration (W9) to free the nick.

  Synchronous probe budget configured via `:login_probe_timeout_ms`
  (default 3s) so nginx 504 never bites — meaningful error reaches
  client in <5s. Test paths can shrink it via the `:login_timeout_ms`
  opt to keep the timeout branch cheap to exercise.
  """

  alias Grappa.{Accounts, Networks, Repo, Session, Visitors}
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.{SessionPlan, Visitor}

  require Logger

  @visitor_network Application.compile_env(:grappa, :visitor_network)
  @login_timeout_ms Application.compile_env(:grappa, [:admission, :login_probe_timeout_ms], 3_000)

  @type input :: %{
          required(:nick) => String.t(),
          required(:password) => String.t() | nil,
          required(:ip) => String.t() | nil,
          required(:user_agent) => String.t() | nil,
          required(:token) => String.t() | nil,
          required(:captcha_token) => String.t() | nil,
          required(:client_id) => String.t() | nil
        }

  @type result :: %{visitor: Visitor.t(), token: Ecto.UUID.t()}

  @type login_error ::
          :malformed_nick
          | :client_cap_exceeded
          | :network_cap_exceeded
          | {:network_circuit_open, non_neg_integer()}
          | :captcha_required
          | :captcha_failed
          | :captcha_provider_unavailable
          | :upstream_unreachable
          | :timeout
          | :no_server
          | :network_unconfigured
          | :password_required
          | :password_mismatch
          | :anon_collision

  @doc """
  Run the synchronous login flow against the configured visitor
  network. `input` carries the request fields (`nick`, `password`,
  `ip`, `user_agent`, `token`, `captcha_token`, `client_id`). `opts`
  accepts `:login_timeout_ms` for tests that need to shrink the probe
  budget.

  Returns `{:ok, %{visitor, token}}` on success or
  `{:error, login_error()}` with the failure reason.
  """
  @spec login(input(), keyword()) :: {:ok, result()} | {:error, login_error()}
  def login(
        %{nick: _, password: _, ip: _, user_agent: _, token: _, captcha_token: _, client_id: _} =
          input,
        opts \\ []
      ) do
    timeout = Keyword.get(opts, :login_timeout_ms, @login_timeout_ms)

    with :ok <- validate_nick(input.nick),
         {:ok, network} <- visitor_network() do
      input.nick
      |> lookup_visitor(network.slug)
      |> dispatch(input, network, timeout)
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
  defp dispatch(nil, input, network, timeout) do
    capacity_input = %{
      subject_kind: :visitor,
      subject_id: nil,
      network_id: network.id,
      client_id: input.client_id,
      flow: :login_fresh
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- Grappa.Admission.verify_captcha(input.captcha_token, input.ip),
         {:ok, visitor} <-
           Visitors.find_or_provision_anon(input.nick, network.slug, input.ip) do
      case continue_case_1(visitor, network, input, timeout) do
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
  defp dispatch(%Visitor{password_encrypted: pwd} = visitor, input, network, timeout)
       when is_binary(pwd) do
    capacity_input = %{
      subject_kind: :visitor,
      subject_id: visitor.id,
      network_id: network.id,
      client_id: input.client_id,
      flow: :login_existing
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- check_password(input.password, pwd) do
      preempt_and_respawn(visitor, network, input, timeout)
    end
  end

  # Case 3 — anon, token gate
  defp dispatch(%Visitor{password_encrypted: nil} = visitor, input, network, _) do
    capacity_input = %{
      subject_kind: :visitor,
      subject_id: visitor.id,
      network_id: network.id,
      client_id: input.client_id,
      flow: :login_existing
    }

    with :ok <- Grappa.Admission.check_capacity(capacity_input),
         :ok <- check_anon_token(input.token, visitor.id) do
      rotate_token(visitor, input)
    end
  end

  defp continue_case_1(visitor, network, input, timeout) do
    with {:ok, _} <- spawn_and_await(visitor, network, timeout) do
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

  defp preempt_and_respawn(visitor, network, input, timeout) do
    :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
    :ok = Visitors.purge_if_anon(visitor.id)
    :ok = Session.stop_session({:visitor, visitor.id}, network.id)
    :ok = Backoff.reset({:visitor, visitor.id}, network.id)

    with {:ok, _} <- spawn_and_await(visitor, network, timeout) do
      :ok = NetworkCircuit.record_success(network.id)
      send_post_login_identify(visitor, network, input.password)
      issue_token(visitor, input)
    end
  end

  defp send_post_login_identify(visitor, network, password) do
    case Session.send_privmsg(
           {:visitor, visitor.id},
           network.id,
           "NickServ",
           "IDENTIFY " <> password
         ) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        # IDENTIFY failure is logged but does not block login. The
        # NSInterceptor (Task 13) + +r MODE observer (Task 15) are
        # the canonical confirmation paths; a transient failure here
        # just means the user has to re-IDENTIFY manually via
        # cicchetto, which the existing PRIVMSG surface already
        # supports.
        #
        # H8 (S17 review): NEVER inspect/1 the raw reason — the
        # `{:error, %Ecto.Changeset{}}` shape from a Scrollback insert
        # validation failure carries the full row including the
        # `body: "IDENTIFY <plaintext>"` field. inspect/1 would print
        # the password to stdout (Phoenix `:filter_parameters`
        # filters HTTP params only, not Logger metadata). Only the
        # error tag is loggable.
        Logger.warning(
          "post-login IDENTIFY failed",
          visitor_id: visitor.id,
          reason: error_tag(reason)
        )

        :ok
    end
  end

  defp error_tag(%Ecto.Changeset{}), do: :scrollback_insert_failed
  defp error_tag(atom) when is_atom(atom), do: atom

  defp rotate_token(visitor, input) do
    :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
    issue_token(visitor, input)
  end

  defp spawn_and_await(visitor, network, timeout) do
    case SessionPlan.resolve(visitor) do
      {:ok, plan} ->
        ref = make_ref()
        plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})

        case Session.start_session({:visitor, visitor.id}, network.id, plan_with_notify) do
          {:ok, pid} ->
            wait_for_ready(visitor.id, network.id, pid, ref, timeout)

          {:error, {:already_started, pid}} ->
            {:ok, pid}

          {:error, _} ->
            {:error, :upstream_unreachable}
        end

      {:error, reason} when reason in [:no_server, :network_unconfigured] ->
        {:error, reason}
    end
  end

  defp wait_for_ready(visitor_id, network_id, pid, ref, timeout) do
    # Monitor the spawned Session.Server so an upstream connect failure
    # (Client crashes with `{:connect_failed, _}` post-init's
    # handle_continue, link kills the Session) surfaces as
    # `:upstream_unreachable` instead of dragging out the full 8s
    # timeout. Without this, the `:transient` policy would also flap
    # on restarts until the SessionSupervisor's max_restarts budget
    # exhausts (cluster-cascading bad). On any DOWN we tear the
    # session down explicitly so the restart loop stops.
    monitor_ref = Process.monitor(pid)

    receive do
      {:session_ready, ^ref} ->
        Process.demonitor(monitor_ref, [:flush])
        {:ok, pid}

      {:DOWN, ^monitor_ref, :process, ^pid, _} ->
        Session.stop_session({:visitor, visitor_id}, network_id)
        {:error, :upstream_unreachable}
    after
      timeout ->
        Process.demonitor(monitor_ref, [:flush])
        Session.stop_session({:visitor, visitor_id}, network_id)
        {:error, :timeout}
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
