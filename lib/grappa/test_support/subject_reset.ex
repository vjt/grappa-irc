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

    ## Baseline channel restore

    Before respawn, each credential is rewritten to its seed-time
    baseline:

      * `last_joined_channels` is cleared to `[]` — strips ephemeral
        channels that earlier specs JOIN'd (e.g. random-suffixed test
        channels). Without this, `Networks.SessionPlan.resolve/1`
        rehydrates the whole accumulated set every reset, blowing
        past the per-network JOIN throttle / MAXCHANNELS budget on
        Bahamut.

      * `autojoin_channels` is restored to `baseline_autojoin[slug]`
        when the caller provides one. `DELETE /networks/.../channels`
        (cic's PART verb, exercised by UX-1, m9-part-x-click,
        cp15-b6) strips the channel from operator-config autojoin
        permanently; the test seed expects `["#bofh"]` to be present
        every time. The fixture knows the seed contract
        (`cicchetto/e2e/fixtures/seedData.ts:AUTOJOIN_CHANNELS`) and
        passes it through.

    After the baseline write, `Session.get_window_state/3` is polled
    for every restored autojoin channel until all reach `:joined` or
    a shared 5s deadline elapses → `{:autojoin_timeout, slug,
    missing}`. Autojoin fires AFTER RPL_WELCOME on the new
    `Session.Server`, so the wait window covers the JOIN + 366
    RPL_ENDOFNAMES round-trip. Pre-fix, reset returned immediately
    after `:session_ready` and the next spec's REST `/channels`
    query raced the in-flight JOINs (sidebar `#bofh` row missing →
    30s `selectChannel` timeout → ~25 cascade victims).
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
        Grappa.Scrollback,
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
      Networks.Credential,
      Push,
      QueryWindows,
      ReadCursor,
      Repo,
      Scrollback,
      Session,
      Uploads,
      UserSettings,
      WSPresence
    }

    @reset_timeout_ms 5_000
    @autojoin_timeout_ms 5_000
    @autojoin_poll_interval_ms 50

    @type baseline_channel :: %{
            required(:name) => String.t(),
            optional(:seed_count) => non_neg_integer(),
            optional(:seed_sender) => String.t()
          }

    @type reset_opts :: %{
            optional(:baseline_autojoin) => %{String.t() => [String.t()]},
            optional(:baseline_seed) => %{String.t() => [baseline_channel()]}
          }

    @type reset_error ::
            :user_not_found
            | {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}
            | {:autojoin_timeout, String.t(), [String.t()]}

    @doc """
    Drain every mutable surface for the user identified by `user_name`.

    `opts.baseline_autojoin` is a map of `network_slug => [channel]`;
    each matching credential's `autojoin_channels` is restored to the
    listed channels before respawn. Credentials for networks not in
    the map keep their current `autojoin_channels`. `last_joined_channels`
    is ALWAYS cleared to `[]` regardless of map contents.

    `opts.baseline_seed` is a map of `network_slug => [%{name,
    seed_count, seed_sender}]`. For each listed channel, the
    `messages` table is truncated to zero rows for the user's
    `(network_id, channel)` and then re-seeded with `seed_count`
    synthetic `:privmsg` rows from `seed_sender` (default
    `"seed-bot"`), monotonically spaced 100ms apart ending at "now".
    Channels not listed keep accumulated scrollback. Runs BEFORE
    Session.Server respawn so the JOIN-cycle's `joined` + topic +
    names rows land cleanly on top of the seed baseline (stable
    post-state: seed_count + ~5 cycle rows per spec).

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
    @spec reset!(String.t(), reset_opts()) :: :ok | {:error, reset_error()}
    def reset!(user_name, opts \\ %{}) when is_binary(user_name) and is_map(opts) do
      case Repo.get_by(Accounts.User, name: user_name) do
        nil -> {:error, :user_not_found}
        %Accounts.User{} = user -> do_reset(user, opts)
      end
    end

    defp do_reset(user, opts) do
      :ok = ReadCursor.clear_all_for_user(user.id)
      :ok = QueryWindows.close_all_for_user(user.id)
      :ok = Push.subscription_clear_all_for_user(user.id)
      :ok = UserSettings.reset_for_user(user.id)
      :ok = Uploads.delete_all_for_user(user.id)
      :ok = WSPresence.reset_for_user(user.name)

      baseline_autojoin = Map.get(opts, :baseline_autojoin, %{})
      baseline_seed = Map.get(opts, :baseline_seed, %{})

      credentials =
        user
        |> Networks.Credentials.list_credentials_for_user()
        |> Enum.map(&restore_baseline_channels(&1, baseline_autojoin))

      :ok = reset_scrollback(user, credentials, baseline_seed)

      respawn_each(user, credentials)
    end

    # Rewrite cred.last_joined_channels + cred.autojoin_channels to
    # the seed baseline so the merged SessionPlan starts every spec
    # with only the channels the test fixture expects. In-memory cred
    # struct is returned so respawn_each sees the post-write shape
    # without an extra Repo.reload.
    defp restore_baseline_channels(cred, baseline) do
      slug = cred.network.slug
      new_autojoin = Map.get(baseline, slug, cred.autojoin_channels)

      attrs = %{
        last_joined_channels: [],
        autojoin_channels: new_autojoin
      }

      {:ok, updated} =
        cred
        |> Credential.changeset(attrs)
        |> Repo.update()

      # Repo.update returns the row without preloads — re-attach the
      # network association from the original cred so downstream code
      # paths (slug lookup, SessionPlan.resolve) work without a refetch.
      %{updated | network: cred.network}
    end

    # Truncate per-(user, network, channel) scrollback to zero rows
    # for every listed baseline channel, then re-insert `seed_count`
    # synthetic `:privmsg` rows. Runs BEFORE respawn so the JOIN
    # cycle's `joined` + topic + names rows land on top of a clean
    # seed baseline. Stable post-state: each spec starts with
    # `seed_count + ~5 cycle rows`. Without this, specs that
    # `send_privmsg`, drive peer JOIN/PRIVMSG, or `seed_scrollback`
    # again would accumulate rows across the run — different visible-
    # tail / marker positions in later specs (CP49 S2 residual
    # cascade post-baseline-restore: 2-5 rotating failures, all
    # iso 5×/10× green, all scrollback-density-driven).
    defp reset_scrollback(user, credentials, baseline_seed) do
      Enum.each(credentials, fn cred ->
        channels = Map.get(baseline_seed, cred.network.slug, [])
        Enum.each(channels, &reset_one_channel(user, cred, &1))
      end)
    end

    defp reset_one_channel(user, cred, spec) when is_map(spec) do
      name = Map.fetch!(spec, :name)
      count = Map.get(spec, :seed_count, 0)
      sender = Map.get(spec, :seed_sender, "seed-bot")

      {:ok, _} = Scrollback.delete_for_channel({:user, user.id}, cred.network_id, name)

      if count > 0, do: seed_synthetic(user, cred.network_id, name, count, sender)
    end

    @seed_gap_ms 100

    defp seed_synthetic(user, network_id, channel, count, sender) do
      base_time = System.system_time(:millisecond) - count * @seed_gap_ms

      Enum.each(1..count, fn i ->
        attrs = %{
          user_id: user.id,
          network_id: network_id,
          channel: channel,
          server_time: base_time + i * @seed_gap_ms,
          kind: :privmsg,
          sender: sender,
          body: "seed line ##{i}",
          meta: %{}
        }

        {:ok, _} = Scrollback.persist_event(attrs)
      end)
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
