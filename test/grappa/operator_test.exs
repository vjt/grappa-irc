defmodule Grappa.OperatorTest do
  @moduledoc """
  Tests for `Grappa.Operator` — the host-side operator-verb entry point
  invoked from `bin/grappa` via `iex --rpc-eval` against the live BEAM.

  ## Test isolation

  `async: false` because every test goes through `Grappa.SessionSupervisor`
  and `Grappa.SessionRegistry` — singleton DynamicSupervisor + Registry
  shared across the suite. The `AdmissionStateHelpers.reset_all()` in
  setup terminates any leftover Session.Servers from prior tests so
  list_sessions_text!/0 starts from a known-empty registry.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO
  import Grappa.AuthFixtures

  alias Grappa.Accounts.User
  alias Grappa.{AdmissionStateHelpers, Operator, Session}
  alias Grappa.Networks.Credential
  alias Grappa.Visitors.Visitor

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_irc_server do
    {:ok, server} = Grappa.IRCServer.start_link(passthrough_handler())
    {server, Grappa.IRCServer.port(server)}
  end

  describe "delete_visitor!/1" do
    test "synchronously terminates the visitor's Session.Server and deletes the row" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      capture_io(fn -> assert :ok = Operator.delete_visitor!(visitor.id) end)

      # Process is dead BEFORE delete_visitor!/1 returned.
      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) == nil
    end

    test "is idempotent: visitor exists but no live Session.Server" do
      visitor = visitor_fixture(network_slug: "azzurra-#{System.unique_integer([:positive])}")
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: visitor.network_slug})

      output = capture_io(fn -> assert :ok = Operator.delete_visitor!(visitor.id) end)

      assert output =~ "deleted visitor #{visitor.id}"
      assert Repo.get(Visitor, visitor.id) == nil
    end

    test "surfaces orphan-network slug on stderr but still deletes the row" do
      # Visitor row pinned to a slug with no `networks` row — happens when
      # the operator drops a network from the DB between visitor creation
      # and recovery. The DB delete still works (no FK, just a string);
      # there's no live session to terminate. Operator sees the stderr
      # signal so they know the row was orphaned.
      visitor = visitor_fixture(network_slug: "orphan-#{System.unique_integer([:positive])}")

      stderr =
        capture_io(:stderr, fn ->
          capture_io(fn -> assert :ok = Operator.delete_visitor!(visitor.id) end)
        end)

      assert stderr =~ "network #{visitor.network_slug} not found"
      assert Repo.get(Visitor, visitor.id) == nil
    end

    test "re-raises Ecto.NoResultsError on unknown id (operator clarity)" do
      bogus_id = Ecto.UUID.generate()

      assert capture_io(:stderr, fn ->
               assert_raise Ecto.NoResultsError, fn ->
                 Operator.delete_visitor!(bogus_id)
               end
             end) =~ "visitor #{bogus_id} not found"
    end
  end

  describe "delete_user/2 (admin user teardown, S7)" do
    test "stops the user's live Session.Server(s) and deletes the row" do
      {_, port} = start_irc_server()
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(vjt, network, %{nick: "vjt"})
      pid = start_session_for(vjt, network)
      ref = Process.monitor(pid)

      assert Session.whereis({:user, vjt.id}, network.id) == pid

      assert :ok = Operator.delete_user(vjt, {"actor-id", "actor-name"})

      # Live pid stopped + row gone BEFORE delete_user/2 returned.
      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:user, vjt.id}, network.id) == nil
      assert Repo.get(User, vjt.id) == nil
    end

    test "is idempotent: user with no live session still deletes the row" do
      vjt = user_fixture(name: "nolive-#{System.unique_integer([:positive])}")

      assert :ok = Operator.delete_user(vjt, {"actor-id", "actor-name"})
      assert Repo.get(User, vjt.id) == nil
    end

    test "refuses :last_admin and tears down NOTHING (row + live session survive)" do
      {_, port} = start_irc_server()
      raw_admin = user_fixture(name: "sole-#{System.unique_integer([:positive])}")
      {:ok, admin} = Grappa.Accounts.update_admin_flags(raw_admin, %{is_admin: true})
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(admin, network, %{nick: "sole"})
      pid = start_session_for(admin, network)

      # The surviving session would otherwise crash on `:tcp_closed` when
      # the test's IRCServer tears down — stop it explicitly (proving the
      # teardown-that-didn't-run is now under our control, not the refusal).
      on_exit(fn -> Session.stop_session({:user, admin.id}, network.id) end)

      assert {:error, :last_admin} = Operator.delete_user(admin, {"actor-id", "actor-name"})

      assert Repo.get(User, admin.id) != nil
      assert Process.alive?(pid)
      assert Session.whereis({:user, admin.id}, network.id) == pid
    end

    test "emits :user_deleted with actor attribution" do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.admin_events())
      vjt = user_fixture(name: "evt-#{System.unique_integer([:positive])}")
      vid = vjt.id
      vname = vjt.name

      assert :ok = Operator.delete_user(vjt, {"actor-id-x", "actor-name-x"})

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :user_deleted,
                         user_id: ^vid,
                         user_name: ^vname,
                         actor_user_id: "actor-id-x",
                         actor_user_name: "actor-name-x"
                       }
                     },
                     500
    end
  end

  describe "reap_visitors!/0" do
    test "deletes expired rows via Reaper.sweep and reports count" do
      expired_at = DateTime.add(DateTime.utc_now(), -1, :hour)
      slug = "reap-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug, expires_at: expired_at)

      output = capture_io(fn -> assert :ok = Operator.reap_visitors!() end)

      assert output =~ "reaped"
      assert Repo.get(Visitor, visitor.id) == nil
    end
  end

  describe "reap_visitors/0 (M-5 typed sibling, no IO)" do
    test "returns {:ok, count} without printing" do
      expired_at = DateTime.add(DateTime.utc_now(), -1, :hour)
      slug = "reap-typed-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug, expires_at: expired_at)

      output =
        capture_io(fn ->
          assert {:ok, n} = Operator.reap_visitors()
          assert n >= 1
        end)

      assert output == ""
      assert Repo.get(Visitor, visitor.id) == nil
    end
  end

  describe "reset_circuit/1 (M-5)" do
    alias Grappa.Admission.NetworkCircuit

    test "clears an open circuit and returns {:ok, nil} (entry gone)" do
      slug = "circuit-#{System.unique_integer([:positive])}"
      {:ok, network} = Grappa.Networks.find_or_create_network(%{slug: slug})

      AdmissionStateHelpers.reset_network_circuit()

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(network.id)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert {:error, :open, _} = NetworkCircuit.check(network.id)

      assert {:ok, nil} = Operator.reset_circuit(network.id)
      assert NetworkCircuit.check(network.id) == :ok
    end

    test "returns {:error, :not_found} on unknown network id" do
      # Pick an id that surely doesn't exist (sqlite autoincrement seq).
      bogus = 999_999_999
      assert Operator.reset_circuit(bogus) == {:error, :not_found}
    end
  end

  describe "list_visitors_text!/0" do
    test "prints header + one tab-separated row per active visitor" do
      slug = "list-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug, nick: "alpha")

      output = capture_io(fn -> assert :ok = Operator.list_visitors_text!() end)

      lines = String.split(output, "\n", trim: true)
      [header | rows] = lines
      assert header =~ "id"
      assert header =~ "nick"
      assert header =~ "network_slug"
      assert header =~ "expires_at"

      assert Enum.any?(rows, fn row ->
               row =~ visitor.id and row =~ "alpha" and row =~ slug
             end)
    end
  end

  describe "list_credentials_text!/0" do
    test "prints header + one row per bound credential, including parked + failed states" do
      {_, port} = start_irc_server()
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      slug = "cred-#{System.unique_integer([:positive])}"
      {network, _} = network_with_server(port: port, slug: slug)
      cred = credential_fixture(vjt, network, %{nick: "vjt"})

      # Demote to :parked so we can verify the verb shows non-:connected
      # rows (Bootstrap's list_credentials_for_all_users/0 would hide
      # this — list_credentials_text! goes through list_all_credentials/0).
      {:ok, _} =
        cred
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "test-parked")
        |> Repo.update()

      output = capture_io(fn -> assert :ok = Operator.list_credentials_text!() end)

      lines = String.split(output, "\n", trim: true)
      [header | rows] = lines
      assert header =~ "user_id"
      assert header =~ "network_slug"
      assert header =~ "nick"
      assert header =~ "state"

      assert Enum.any?(rows, fn row ->
               row =~ vjt.id and row =~ slug and row =~ "vjt" and
                 row =~ "parked" and row =~ "test-parked"
             end)
    end
  end

  describe "list_sessions_text!/0" do
    test "prints header + one row per live Session.Server with introspection" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)

      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      output = capture_io(fn -> assert :ok = Operator.list_sessions_text!() end)

      lines = String.split(output, "\n", trim: true)
      [header | rows] = lines
      assert header =~ "subject_kind"
      assert header =~ "subject_id"
      assert header =~ "network_id"
      assert header =~ "pid"
      assert header =~ "alive"
      assert header =~ "mailbox_len"
      assert header =~ "memory_kb"

      assert Enum.any?(rows, fn row ->
               row =~ "visitor" and row =~ visitor.id and
                 row =~ inspect(pid) and row =~ "true"
             end)
    end

    test "prints just the header when no sessions are registered" do
      output = capture_io(fn -> assert :ok = Operator.list_sessions_text!() end)
      lines = String.split(output, "\n", trim: true)
      assert length(lines) == 1
      assert hd(lines) =~ "subject_kind"
    end
  end

  describe "terminate_session/3 (M-9a)" do
    test "stops the visitor pid and leaves the visitor row" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert :ok = Operator.terminate_session({:visitor, visitor.id}, network.id, nil)

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) != nil
    end

    test "stops the user pid and leaves the credential row (state still :connected)" do
      {_, port} = start_irc_server()
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(vjt, network, %{nick: "vjt"})
      pid = start_session_for(vjt, network)
      ref = Process.monitor(pid)

      assert :ok = Operator.terminate_session({:user, vjt.id}, network.id, nil)

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:user, vjt.id}, network.id) == nil
      reloaded = Repo.get_by(Credential, user_id: vjt.id, network_id: network.id)
      assert reloaded.connection_state == :connected
    end

    test "is idempotent: no pid registered returns :ok" do
      assert :ok =
               Operator.terminate_session(
                 {:visitor, Ecto.UUID.generate()},
                 999_999_999,
                 nil
               )
    end

    test "returns {:error, :cannot_disconnect_self} when actor_user_id matches user subject" do
      actor_id = Ecto.UUID.generate()

      assert {:error, :cannot_disconnect_self} =
               Operator.terminate_session({:user, actor_id}, 1, actor_id)
    end

    test "skips self-check for visitor subjects even when ids match" do
      # actor_user_id is a user UUID; the visitor UUID never collides
      # with it in practice — but the contract is "visitor subjects
      # bypass the self-check regardless." Pass the same UUID through
      # both slots; the {:visitor, _} pattern wins.
      same_uuid = Ecto.UUID.generate()
      assert :ok = Operator.terminate_session({:visitor, same_uuid}, 1, same_uuid)
    end
  end

  describe "disconnect_session/3 (M-9a)" do
    test "user :connected → :parked + pid gone" do
      {_, port} = start_irc_server()
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(vjt, network, %{nick: "vjt"})
      pid = start_session_for(vjt, network)
      ref = Process.monitor(pid)

      assert :ok = Operator.disconnect_session({:user, vjt.id}, network.id, nil)

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:user, vjt.id}, network.id) == nil
      reloaded = Repo.get_by(Credential, user_id: vjt.id, network_id: network.id)
      assert reloaded.connection_state == :parked
    end

    test "user :parked → :ok (idempotent, no DB change)" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: 1)
      cred = credential_fixture(vjt, network, %{nick: "vjt"})

      {:ok, _} =
        cred
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "test")
        |> Repo.update()

      assert :ok = Operator.disconnect_session({:user, vjt.id}, network.id, nil)

      reloaded = Repo.get_by(Credential, user_id: vjt.id, network_id: network.id)
      assert reloaded.connection_state == :parked
    end

    test "user :failed → :ok (idempotent)" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: 1)
      cred = credential_fixture(vjt, network, %{nick: "vjt"})

      {:ok, _} =
        cred
        |> Ecto.Changeset.change(connection_state: :failed, connection_state_reason: "k-line")
        |> Repo.update()

      assert :ok = Operator.disconnect_session({:user, vjt.id}, network.id, nil)

      reloaded = Repo.get_by(Credential, user_id: vjt.id, network_id: network.id)
      assert reloaded.connection_state == :failed
    end

    test "user with no credential row → {:error, :not_found}" do
      assert {:error, :not_found} =
               Operator.disconnect_session(
                 {:user, Ecto.UUID.generate()},
                 999_999_999,
                 nil
               )
    end

    test "visitor collapses to terminate (pid gone, row preserved)" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert :ok = Operator.disconnect_session({:visitor, visitor.id}, network.id, nil)

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) != nil
    end

    test "returns {:error, :cannot_disconnect_self} for self-target user" do
      # MED-4 (M-11 review): credential must exist for the self-check to
      # fire — otherwise the function correctly returns :not_found
      # before reaching the self-protect branch (so 422 vs 404 doesn't
      # leak "this network has a row" to an unauthorized caller).
      {_, port} = start_irc_server()
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(vjt, network, %{nick: "vjt"})

      assert {:error, :cannot_disconnect_self} =
               Operator.disconnect_session({:user, vjt.id}, network.id, vjt.id)
    end

    test "actor_user_id == nil disables the self-check (operator override path)" do
      # User has no credential row, so the disconnect would fall through to
      # :not_found if the self-check were skipped — that's what we want
      # to assert: self-check is bypassed when actor_user_id is nil even
      # if a same-uuid actor would otherwise match.
      user_id = Ecto.UUID.generate()

      assert {:error, :not_found} =
               Operator.disconnect_session({:user, user_id}, 999_999_999, nil)
    end
  end

  describe "Visitors.update_identity/2 live-apply reconnect (#152)" do
    alias Grappa.Visitors

    test "a live session is bounced (new pid) and the fresh plan carries the new ident" do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      old_pid = start_visitor_session_for(visitor, network)
      old_ref = Process.monitor(old_pid)

      assert Session.whereis({:visitor, visitor.id}, network.id) == old_pid

      assert {:ok, updated} = Visitors.update_identity(visitor, %{ident: "grp", realname: "RN"})
      assert updated.ident == "grp"
      assert updated.realname == "RN"

      # The old Session.Server was torn down (graceful QUIT + stop) and a
      # fresh one respawned — proving the reconnect fired, not a no-op.
      assert_receive {:DOWN, ^old_ref, :process, ^old_pid, _}, 1_000

      new_pid = Session.whereis({:visitor, visitor.id}, network.id)
      assert is_pid(new_pid)
      assert new_pid != old_pid
      register_reconnect_cleanup(new_pid)

      # The respawn's refresh_plan re-reads the just-persisted row, so the
      # fresh plan carries the new ident/realname — this is what lands in
      # the new USER line at re-registration.
      {:ok, plan} = Grappa.Visitors.SessionPlan.resolve(Grappa.Repo.reload!(visitor))
      assert plan.ident == "grp"
      assert plan.realname == "RN"
    end

    test "no live session → persist only, no spawn" do
      # No IRC server started + no session spawned for this visitor.
      {visitor, network} = visitor_with_network(1)

      # No session started for this visitor.
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil

      assert {:ok, updated} = Visitors.update_identity(visitor, %{ident: "grp"})
      assert updated.ident == "grp"
      # Still no session — persist path didn't spawn one.
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
    end

    defp register_reconnect_cleanup(pid) do
      on_exit(fn ->
        _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
      end)
    end
  end
end
