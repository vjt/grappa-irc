defmodule Grappa.SpawnOrchestratorTest do
  @moduledoc """
  Tests for `Grappa.SpawnOrchestrator` — the admission →
  backoff-reset → spawn dance promoted out of `Bootstrap` and
  `NetworksController` (cluster #8, Theme 3 / resp-A1 / ext-A9
  god-module decomposition, 3/3 — verb-reuse counterpart to clusters
  #6 + #7's noun-reuse extractions).

  These tests cover the orchestrator IN ISOLATION. The two production
  call sites (`Bootstrap.spawn_with_admission/6` →
  `Bootstrap.spawn_one/2` + `Bootstrap.spawn_visitor/2` and
  `NetworksController.spawn_session_after_connect/3`) keep their own
  end-to-end coverage in `bootstrap_test.exs` +
  `networks_controller_test.exs`. The dance itself is exercised here
  so a regression in the orchestrator surfaces with a focused failure
  rather than a far-removed integration breakage.

  `async: false` because `Grappa.SessionSupervisor` +
  `Grappa.SessionRegistry` + `Grappa.Session.Backoff` are
  application-wide singletons; concurrent tests would collide on
  network_id-keyed state.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdmissionStateHelpers, IRCServer, Networks, Session, SpawnOrchestrator}
  alias Grappa.Networks.{Credentials, Servers, SessionPlan}
  alias Grappa.Session.Backoff

  # NetworkCircuit + Backoff are ETS-backed application singletons that
  # outlive the Ecto sandbox AND the container's `mix test` boundary
  # (the table is reborn on supervisor restart but stale rows from a
  # prior container can collide with the next test's auto-increment
  # network_id). Without this reset, tests intermittently fail with
  # `{:network_circuit_open, _}` whose surface line/file does not predict
  # the offending pair (memory `project_network_circuit_ets_leak`).
  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_credential(user, slug, port, opts \\ %{}) do
    {:ok, base_network} = Networks.find_or_create_network(%{slug: slug})
    {:ok, _} = Servers.add_server(base_network, %{host: "127.0.0.1", port: port, tls: false})

    cap_attrs =
      opts
      |> Map.take([:max_concurrent_visitor_sessions, :max_concurrent_user_sessions])
      |> Enum.reject(&match?({_, nil}, &1))
      |> Map.new()

    network =
      case map_size(cap_attrs) do
        0 ->
          base_network

        _ ->
          {:ok, capped} =
            base_network
            |> Networks.Network.changeset(cap_attrs)
            |> Repo.update()

          capped
      end

    {:ok, credential} =
      Credentials.bind_credential(user, network, %{
        nick: "vjt",
        auth_method: :none,
        autojoin_channels: []
      })

    {:ok, plan} = SessionPlan.resolve(credential)
    {network, plan}
  end

  defp stop_session(subject, network_id) do
    case Session.whereis(subject, network_id) do
      nil ->
        :ok

      pid ->
        ref = Process.monitor(pid)
        _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          500 -> Process.demonitor(ref, [:flush])
        end
    end
  end

  defp clear_registry_for(network_id) when is_integer(network_id) do
    pids =
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, :_, network_id}, :"$1", :_}, [], [:"$1"]}
      ])

    Enum.each(pids, fn pid ->
      ref = Process.monitor(pid)
      _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)

      receive do
        {:DOWN, ^ref, :process, ^pid, _} -> :ok
      after
        500 -> Process.demonitor(ref, [:flush])
      end
    end)

    # PHASE-1 (post-cr-review cluster, CI flake on
    # spawn_orchestrator_test:179 "network_cap_exceeded"): poll until
    # the Registry observes count == 0 for THIS network_id. Mirrors
    # bootstrap_test.exs's `wait_until_registry_clear/2` helper added
    # in T31 cleanup. Without this wait, an earlier test's session
    # whose `on_exit` cleanup had its 500ms `:DOWN` receive expire can
    # leave a zombie registered against a network.id that sqlite
    # rowid-recycles into a fresh test's `network.id` — admission's
    # `count_live_sessions/1` then reads "1 already" against cap=1
    # and the FIRST `SpawnOrchestrator.spawn/4` returns
    # `:network_cap_exceeded` instead of `:spawned`.
    wait_until_registry_clear(network_id, 100)
  end

  defp wait_until_registry_clear(_, 0), do: :ok

  defp wait_until_registry_clear(network_id, attempts) do
    count =
      Registry.count_select(Grappa.SessionRegistry, [
        {{{:session, :_, network_id}, :_, :_}, [], [true]}
      ])

    if count == 0 do
      :ok
    else
      Process.sleep(5)
      wait_until_registry_clear(network_id, attempts - 1)
    end
  end

  defp capacity_input(network_id, flow) do
    %{network_id: network_id, client_id: nil, flow: flow, requesting_subject: nil}
  end

  # `Backoff.{record_failure,reset}/2` are GenServer casts; a sync
  # call against the same process is the canonical way to wait for
  # the cast to be processed before reading ETS via `failure_count/2`.
  defp sync_backoff, do: :sys.get_state(Backoff)

  describe "spawn/4 happy path" do
    test "admission ok + fresh session — returns {:ok, :spawned, pid}" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "happy-#{System.unique_integer([:positive])}"
      {network, plan} = setup_credential(vjt, slug, port)
      :ok = clear_registry_for(network.id)
      on_exit(fn -> stop_session({:user, vjt.id}, network.id) end)

      subject = {:user, vjt.id}

      assert {:ok, :spawned, pid} =
               SpawnOrchestrator.spawn(
                 subject,
                 network.id,
                 plan,
                 capacity_input(network.id, :bootstrap_user)
               )

      assert is_pid(pid)
      assert Process.alive?(pid)
      assert Session.whereis(subject, network.id) == pid
    end
  end

  describe "spawn/4 idempotency" do
    test "second call against live session returns {:ok, :already_started, pid}" do
      vjt = user_fixture(name: "idempot-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "idempot-#{System.unique_integer([:positive])}"
      {network, plan} = setup_credential(vjt, slug, port)
      :ok = clear_registry_for(network.id)
      on_exit(fn -> stop_session({:user, vjt.id}, network.id) end)

      subject = {:user, vjt.id}
      cap_in = capacity_input(network.id, :bootstrap_user)

      assert {:ok, :spawned, first_pid} =
               SpawnOrchestrator.spawn(subject, network.id, plan, cap_in)

      assert {:ok, :already_started, ^first_pid} =
               SpawnOrchestrator.spawn(subject, network.id, plan, cap_in)
    end
  end

  describe "spawn/4 operator-delete fail-fast" do
    test "refresh_plan returning {:error, :not_found} → {:ok, :ignored}, no session spawned" do
      vjt = user_fixture(name: "ignored-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "ignored-#{System.unique_integer([:positive])}"
      {network, plan} = setup_credential(vjt, slug, port)
      :ok = clear_registry_for(network.id)

      subject = {:user, vjt.id}

      # Override the production `refresh_plan` closure with a
      # constant `{:error, :not_found}` stub so init/1 short-circuits
      # even though the credential row IS present in the fixture DB.
      # This isolates the init-gate behaviour from the DB row lifecycle.
      gated_plan = Map.put(plan, :refresh_plan, fn -> {:error, :not_found} end)

      assert {:ok, :ignored} =
               SpawnOrchestrator.spawn(
                 subject,
                 network.id,
                 gated_plan,
                 capacity_input(network.id, :bootstrap_user)
               )

      assert Session.whereis(subject, network.id) == nil
    end
  end

  describe "spawn/4 admission rejection" do
    test "user_cap_exceeded — returns {:error, :user_cap_exceeded}, no session spawned" do
      vjt_a = user_fixture(name: "capa-#{System.unique_integer([:positive])}")
      vjt_b = user_fixture(name: "capb-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "cap-#{System.unique_integer([:positive])}"

      {network, plan_a} = setup_credential(vjt_a, slug, port, %{max_concurrent_user_sessions: 1})

      {:ok, cred_b} =
        Credentials.bind_credential(vjt_b, network, %{
          nick: "vjtb",
          auth_method: :none,
          autojoin_channels: []
        })

      {:ok, plan_b} = SessionPlan.resolve(cred_b)

      :ok = clear_registry_for(network.id)
      on_exit(fn -> clear_registry_for(network.id) end)

      cap_in = capacity_input(network.id, :bootstrap_user)

      assert {:ok, :spawned, _} =
               SpawnOrchestrator.spawn({:user, vjt_a.id}, network.id, plan_a, cap_in)

      # U-2: user-flow consults max_concurrent_user_sessions.
      assert {:error, :user_cap_exceeded} =
               SpawnOrchestrator.spawn({:user, vjt_b.id}, network.id, plan_b, cap_in)

      assert Session.whereis({:user, vjt_b.id}, network.id) == nil
    end
  end

  describe "spawn/4 backoff reset semantics (M-life-5)" do
    test "successful admission clears prior Backoff failure history before spawn" do
      vjt = user_fixture(name: "bo-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "bo-#{System.unique_integer([:positive])}"
      {network, plan} = setup_credential(vjt, slug, port)
      :ok = clear_registry_for(network.id)
      on_exit(fn -> stop_session({:user, vjt.id}, network.id) end)

      subject = {:user, vjt.id}

      # Prime Backoff with synthetic prior failures to assert the
      # orchestrator clears them. M-life-5: any operator-driven
      # spawn (Bootstrap or PATCH /connect) overrides stale failure
      # history — the alternative would penalize an operator's
      # explicit retry against a freshly-restarted upstream.
      :ok = Backoff.record_failure(subject, network.id)
      :ok = Backoff.record_failure(subject, network.id)
      _ = sync_backoff()
      assert Backoff.failure_count(subject, network.id) == 2

      assert {:ok, :spawned, _} =
               SpawnOrchestrator.spawn(
                 subject,
                 network.id,
                 plan,
                 capacity_input(network.id, :bootstrap_user)
               )

      _ = sync_backoff()
      assert Backoff.failure_count(subject, network.id) == 0
    end

    test "rejected admission does NOT reset Backoff (no operator action took effect)" do
      vjt_a = user_fixture(name: "bo-noreset-#{System.unique_integer([:positive])}")
      vjt_b = user_fixture(name: "bo-noreset-b-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      slug = "boreject-#{System.unique_integer([:positive])}"

      {network, plan_a} = setup_credential(vjt_a, slug, port, %{max_concurrent_user_sessions: 1})

      {:ok, cred_b} =
        Credentials.bind_credential(vjt_b, network, %{
          nick: "vjtb",
          auth_method: :none,
          autojoin_channels: []
        })

      {:ok, plan_b} = SessionPlan.resolve(cred_b)

      :ok = clear_registry_for(network.id)
      on_exit(fn -> clear_registry_for(network.id) end)

      subject_b = {:user, vjt_b.id}
      cap_in = capacity_input(network.id, :bootstrap_user)

      # Trip the cap with vjt_a first.
      assert {:ok, :spawned, _} =
               SpawnOrchestrator.spawn({:user, vjt_a.id}, network.id, plan_a, cap_in)

      # Prime vjt_b with a prior failure that must NOT be cleared by
      # the cap-rejected attempt.
      :ok = Backoff.record_failure(subject_b, network.id)
      _ = sync_backoff()
      assert Backoff.failure_count(subject_b, network.id) == 1

      # U-2: user-flow cap atom.
      assert {:error, :user_cap_exceeded} =
               SpawnOrchestrator.spawn(subject_b, network.id, plan_b, cap_in)

      _ = sync_backoff()
      assert Backoff.failure_count(subject_b, network.id) == 1
    end
  end
end
