if Mix.env() in [:dev, :test] do
  defmodule Grappa.TestSupport.SubjectReset do
    @moduledoc """
    Test-only orchestrator that drains every mutable surface owned by
    a seed user (DB rows + live `Session.Server` state + ETS
    entries), so Playwright's afterEach gives every spec a clean
    baseline. Compile-gated to `:dev` and `:test` Mix envs — the
    module literally does not exist in the prod release.

    Wired via `POST /admin/test/reset-subject`
    (`GrappaWeb.Admin.TestResetSubjectController` — T9), itself
    compile-gated in `lib/grappa_web/router.ex`. See
    `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`
    for the full design + the rotating-victim cascade this fixes.

    Session.Server restart awaits `{:session_ready, ref}` (001
    RPL_WELCOME) via the existing `notify_pid` mechanism — same
    primitive `Visitors.Login.preempt_and_respawn/4` uses
    (`lib/grappa/visitors/login.ex:280-417`). Hard 5s timeout per
    credential → `{:error, {:reconnect_timeout, network_slug}}`. No
    silent retry loops; loud failure surfaces upstream sickness.

    Only respawns credentials in `:connected` state. Parked/failed
    credentials get their Backoff + NetworkCircuit reset but no respawn
    attempt — they're already not-running and shouldn't be started by
    a test cleanup verb.
    """

    use Boundary,
      top_level?: true,
      deps: [
        Grappa.Accounts,
        Grappa.Admission,
        Grappa.Networks,
        Grappa.Push,
        Grappa.QueryWindows,
        Grappa.ReadCursor,
        Grappa.Repo,
        Grappa.Session,
        Grappa.SpawnOrchestrator,
        Grappa.Uploads,
        Grappa.UserSettings,
        Grappa.WSPresence
      ]

    alias Grappa.{
      Accounts,
      Admission.NetworkCircuit,
      Networks,
      Push,
      QueryWindows,
      ReadCursor,
      Repo,
      Session,
      Uploads,
      UserSettings,
      WSPresence
    }

    require Logger

    @reset_timeout_ms 5_000

    @type reset_error ::
            :user_not_found
            | {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}

    @doc """
    Drain every mutable surface for the user identified by `user_name`.

    Returns `:ok` on success. Returns `{:error, :user_not_found}` if
    the user_name doesn't exist. Returns `{:error, {:reconnect_timeout,
    network_slug}}` if a `Session.Server` restart didn't reach
    `:session_ready` within #{@reset_timeout_ms}ms. Returns `{:error,
    {:reconnect_failed, network_slug, reason}}` for any other
    `SpawnOrchestrator` / `SessionPlan` failure.
    """
    @spec reset!(String.t()) :: :ok | {:error, reset_error()}
    def reset!(user_name) when is_binary(user_name) do
      case Repo.get_by(Accounts.User, name: user_name) do
        nil -> {:error, :user_not_found}
        %Accounts.User{} = user -> do_reset(user)
      end
    end

    defp do_reset(user) do
      :ok = ReadCursor.clear_all_for_user(user.id)
      :ok = QueryWindows.close_all_for_user(user.id)
      :ok = Push.subscription_clear_all_for_user(user.id)
      :ok = UserSettings.reset_for_user(user.id)
      :ok = Uploads.delete_all_for_user(user.id)
      :ok = WSPresence.reset_for_user(user.name)

      credentials = Networks.Credentials.list_credentials_for_user(user)
      respawn_each(user, credentials)
    end

    defp respawn_each(_, []), do: :ok

    defp respawn_each(user, [cred | rest]) do
      network_id = cred.network_id
      # `list_credentials_for_user/1` preloads `:network` already, but
      # be defensive — a future refactor that drops the preload would
      # silently crash on `cred.network.slug` here otherwise.
      cred = Repo.preload(cred, :network)
      slug = cred.network.slug

      :ok = NetworkCircuit.reset_sync(network_id)
      :ok = Grappa.Session.Backoff.reset({:user, user.id}, network_id)

      case cred.connection_state do
        :connected ->
          :ok = Session.stop_session({:user, user.id}, network_id)

          case spawn_and_await(user, cred, slug) do
            :ok -> respawn_each(user, rest)
            {:error, _} = err -> err
          end

        _ ->
          # Parked / failed / disconnected — no respawn. Backoff +
          # circuit already reset above.
          respawn_each(user, rest)
      end
    end

    defp spawn_and_await(user, cred, slug) do
      case Networks.SessionPlan.resolve(cred) do
        {:ok, plan} ->
          ref = make_ref()
          plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})

          capacity_input = %{
            network_id: cred.network_id,
            client_id: nil,
            flow: :bootstrap_user,
            requesting_subject: {:user, user.id}
          }

          case Grappa.SpawnOrchestrator.spawn(
                 {:user, user.id},
                 cred.network_id,
                 plan_with_notify,
                 capacity_input
               ) do
            {:ok, _, pid} -> await_ready(pid, ref, slug)
            {:error, reason} -> {:error, {:reconnect_failed, slug, reason}}
          end

        {:error, reason} ->
          {:error, {:reconnect_failed, slug, reason}}
      end
    end

    defp await_ready(pid, ref, slug) do
      monitor_ref = Process.monitor(pid)

      receive do
        {:session_ready, ^ref} ->
          Process.demonitor(monitor_ref, [:flush])
          :ok

        {:DOWN, ^monitor_ref, :process, ^pid, reason} ->
          {:error, {:reconnect_failed, slug, reason}}
      after
        @reset_timeout_ms ->
          Process.demonitor(monitor_ref, [:flush])
          {:error, {:reconnect_timeout, slug}}
      end
    end
  end
end
