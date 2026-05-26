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

    5s is intentionally tight for a test-only path. The e2e testnet
    runs Bahamut on local-loopback; a >5s WELCOME means upstream
    sickness or `Session.Server` crash-loop, NOT transient network
    slowness. Reset is never called against real-world upstreams
    (compile-gated to dev/test envs). `Visitors.Login`'s 30s welcome
    budget targets real upstreams; test-reset's 5s targets
    local-loopback.

    Only respawns credentials in `:connected` state. Parked/failed
    credentials get their Backoff + NetworkCircuit reset but no respawn
    attempt — they're already not-running and shouldn't be started by
    a test cleanup verb.

    After `:session_ready` (001 RPL_WELCOME) lands, additionally waits
    for every `autojoin_channels` entry to reach `:joined` window-state
    via `Session.get_window_state/3`. Autojoin fires AFTER 001 (see
    `Session.Server.handle_info({:irc, %Message{command: {:numeric, 1}}}, …)`),
    so without this gate the reset returns into a window where the
    next spec's REST `/networks/<slug>/channels` query races the
    upstream JOIN ack and observes an empty sidebar — root cause of
    the chromium suite cascade observed in T14 (~25 victims, all
    `selectChannel(#bofh)` 30s timeouts). Shared 5s budget across all
    autojoin channels for a credential; same loud-failure rationale
    as the welcome wait — local-loopback Bahamut joins should ack in
    <1s, multi-second misses signal upstream sickness.
    """

    use Boundary,
      top_level?: true,
      deps: [
        Grappa.Accounts,
        Grappa.Admission,
        Grappa.IRC,
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

    @reset_timeout_ms 5_000
    @autojoin_timeout_ms 5_000
    @autojoin_poll_interval_ms 50

    @type reset_error ::
            :user_not_found
            | {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}
            | {:autojoin_timeout, String.t(), [String.t()]}

    @doc """
    Drain every mutable surface for the user identified by `user_name`.

    Returns `:ok` on success. Returns `{:error, :user_not_found}` if
    the user_name doesn't exist. Returns `{:error, {:reconnect_timeout,
    network_slug}}` if a `Session.Server` restart didn't reach
    `:session_ready` within #{@reset_timeout_ms}ms. Returns `{:error,
    {:reconnect_failed, network_slug, reason}}` for any other
    `SpawnOrchestrator` / `SessionPlan` failure. Returns `{:error,
    {:autojoin_timeout, network_slug, missing_channels}}` if any
    `autojoin_channels` entry has not reached `:joined` state within
    #{@autojoin_timeout_ms}ms after `:session_ready`.
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
      slug = cred.network.slug

      :ok = NetworkCircuit.reset_sync(network_id)
      :ok = Grappa.Session.Backoff.reset({:user, user.id}, network_id)

      case cred.connection_state do
        :connected ->
          :ok = Session.stop_session({:user, user.id}, network_id)

          with {:ok, autojoin} <- spawn_and_await(user, cred, slug),
               :ok <- await_autojoin(user, cred, slug, autojoin) do
            respawn_each(user, rest)
          else
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
        {:ok, plan} -> do_spawn_and_await(user, cred, slug, plan)
        {:error, reason} -> {:error, {:reconnect_failed, slug, reason}}
      end
    end

    defp do_spawn_and_await(user, cred, slug, plan) do
      ref = make_ref()
      plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})

      capacity_input = %{
        network_id: cred.network_id,
        client_id: nil,
        flow: :bootstrap_user,
        requesting_subject: nil
      }

      case Grappa.SpawnOrchestrator.spawn(
             {:user, user.id},
             cred.network_id,
             plan_with_notify,
             capacity_input
           ) do
        {:ok, _, pid} ->
          case await_ready(pid, ref, slug) do
            :ok -> {:ok, Map.get(plan, :autojoin_channels, [])}
            {:error, _} = err -> err
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

    # Poll Session.Server's window_state for every autojoin channel
    # until all observe `:joined`, or the shared budget elapses.
    # `Session.get_window_state/3` returns `{:ok, %{state: "joined"}}`
    # once `Session.WindowState.set_joined/2` has fired (366
    # RPL_ENDOFNAMES path) and `{:error, :not_tracked}` for pending /
    # parked / unknown — the same `:not_tracked` covers both
    # "JOIN-in-flight" and "channel was never autojoin'd" so we
    # cannot distinguish them from the outside; the shared timeout
    # is the disambiguator.
    #
    # `autojoin` here is the RESOLVED Session.Plan list, NOT
    # `cred.autojoin_channels` — `Networks.SessionPlan.resolve/1`
    # merges operator-config + `last_joined_channels`, and the
    # Session.Server JOINs the merged set on RPL_WELCOME. Polling
    # only `cred.autojoin_channels` would let `#bofh` slip through
    # whenever an earlier spec PARTed it (DELETE /channels strips
    # operator-config autojoin but leaves it in `last_joined`).
    defp await_autojoin(_, _, _, []), do: :ok

    defp await_autojoin(user, cred, slug, autojoin) do
      deadline = System.monotonic_time(:millisecond) + @autojoin_timeout_ms

      pending =
        autojoin
        |> Enum.map(&Grappa.IRC.Identifier.canonical_channel/1)
        |> MapSet.new()

      poll_autojoin({:user, user.id}, cred.network_id, slug, pending, deadline)
    end

    defp poll_autojoin(subject, network_id, slug, pending, deadline) do
      remaining =
        Enum.reduce(pending, pending, fn channel, acc ->
          case Session.get_window_state(subject, network_id, channel) do
            {:ok, %{state: "joined"}} -> MapSet.delete(acc, channel)
            _ -> acc
          end
        end)

      cond do
        MapSet.size(remaining) == 0 ->
          :ok

        System.monotonic_time(:millisecond) >= deadline ->
          {:error, {:autojoin_timeout, slug, Enum.sort(MapSet.to_list(remaining))}}

        true ->
          Process.sleep(@autojoin_poll_interval_ms)
          poll_autojoin(subject, network_id, slug, remaining, deadline)
      end
    end
  end
end
