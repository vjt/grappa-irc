defmodule Grappa.Networks.ConnectionStateTest do
  @moduledoc """
  Tests for `Grappa.Networks.{connect/1, disconnect/2, mark_failed/2}` —
  the T32 state-transition entry points (channel-client-polish S1.2).

  Per the S1.2 boundary note: these context fns do **DB transition +
  PubSub broadcast + (for the stop-shape paths) `Session.stop_session/2`
  / explicit upstream QUIT**. They do NOT spawn Session.Server — that
  orchestration (admission + start_session) lives at the caller
  (NetworkController for `/connect`, `Bootstrap` at boot) where
  `Grappa.Admission` is already a clean dep.

  Uses `Grappa.IRCServer` (in-process TCP fake) for the QUIT-upstream
  assertion on `disconnect/2` and the live-session-termination
  assertion on `mark_failed/2`. `async: false` because
  `SessionRegistry`, `SessionSupervisor`, and `PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, Repo, Session}
  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.PubSub.Topic

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_credential(port, attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    credential = credential_fixture(user, network, attrs)
    {user, network, credential}
  end

  # Sets connection_state on a credential row directly (bypasses
  # validation — tests need to seed `:parked` / `:failed` rows
  # without going through the `Networks.connect/disconnect/mark_failed`
  # entry points the tests are themselves verifying).
  defp set_state(%Credential{} = cred, state, reason) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    cred
    |> Ecto.Changeset.change(%{
      connection_state: state,
      connection_state_reason: reason,
      connection_state_changed_at: now
    })
    |> Repo.update!()
  end

  defp reload(%Credential{} = cred) do
    Repo.get_by!(Credential, user_id: cred.user_id, network_id: cred.network_id)
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  describe "connect/1" do
    test "transitions :parked → :connected, clears reason, broadcasts" do
      {_, port} = start_server()
      {user, network, fresh} = setup_credential(port)
      cred = set_state(fresh, :parked, "manual")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:ok, updated} = Networks.connect(cred)
      assert updated.connection_state == :connected
      assert updated.connection_state_reason == nil
      assert %DateTime{} = updated.connection_state_changed_at

      slug = network.slug
      uid = user.id
      nid = network.id

      assert_receive {:connection_state_changed,
                      %{
                        user_id: ^uid,
                        network_id: ^nid,
                        network_slug: ^slug,
                        from: :parked,
                        to: :connected,
                        reason: nil,
                        at: %DateTime{}
                      }},
                     500

      reloaded = reload(cred)
      assert reloaded.connection_state == :connected
      assert reloaded.connection_state_reason == nil
    end

    test "transitions :failed → :connected, clears reason, broadcasts" do
      {_, port} = start_server()
      {user, network, fresh} = setup_credential(port)
      cred = set_state(fresh, :failed, "k-line: trial")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:ok, updated} = Networks.connect(cred)
      assert updated.connection_state == :connected
      assert updated.connection_state_reason == nil

      assert_receive {:connection_state_changed, %{from: :failed, to: :connected}}, 500
    end

    test "idempotent on :connected — returns row unchanged, no broadcast" do
      {_, port} = start_server()
      {user, network, cred} = setup_credential(port)
      assert cred.connection_state == :connected
      original_changed_at = cred.connection_state_changed_at

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:ok, returned} = Networks.connect(cred)
      assert returned.connection_state == :connected
      assert returned.connection_state_reason == cred.connection_state_reason
      assert returned.connection_state_changed_at == original_changed_at

      refute_receive {:connection_state_changed, _}, 100
    end
  end

  describe "disconnect/2" do
    test "from :connected with live session: sends QUIT upstream, terminates session, transitions :parked, broadcasts" do
      {server, port} = start_server()
      {user, network, cred} = setup_credential(port)
      assert cred.connection_state == :connected

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      ref = Process.monitor(pid)

      assert {:ok, updated} = Networks.disconnect(cred, "user-disconnect")

      assert {:ok, "QUIT :user-disconnect\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "QUIT"))

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil

      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "user-disconnect"
      assert %DateTime{} = updated.connection_state_changed_at

      assert_receive {:connection_state_changed, %{from: :connected, to: :parked, reason: "user-disconnect"}},
                     500
    end

    test "from :connected with no live session: transitions :parked, broadcasts (best-effort QUIT skipped silently)" do
      {_, port} = start_server()
      {user, network, cred} = setup_credential(port)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:ok, updated} = Networks.disconnect(cred, "manual")
      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "manual"

      assert_receive {:connection_state_changed, %{from: :connected, to: :parked}}, 500
    end

    test "from :parked: returns {:error, :not_connected} unchanged" do
      {_, port} = start_server()
      {user, network, fresh} = setup_credential(port)
      cred = set_state(fresh, :parked, "first")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:error, :not_connected} = Networks.disconnect(cred, "second")
      refute_receive {:connection_state_changed, _}, 100

      reloaded = reload(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.connection_state_reason == "first"
    end

    test "from :failed: returns {:error, :not_connected} unchanged" do
      {_, port} = start_server()
      {_, _, fresh} = setup_credential(port)
      cred = set_state(fresh, :failed, "k-line: trial")

      assert {:error, :not_connected} = Networks.disconnect(cred, "manual")
      reloaded = reload(cred)
      assert reloaded.connection_state == :failed
      assert reloaded.connection_state_reason == "k-line: trial"
    end
  end

  describe "mark_failed/2" do
    test "from :connected with live session: terminates session, transitions :failed, broadcasts" do
      {server, port} = start_server()
      {user, network, cred} = setup_credential(port)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      ref = Process.monitor(pid)

      assert {:ok, updated} = Networks.mark_failed(cred, "k-line: G:Lined")

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil

      assert updated.connection_state == :failed
      assert updated.connection_state_reason == "k-line: G:Lined"

      assert_receive {:connection_state_changed, %{from: :connected, to: :failed, reason: "k-line: G:Lined"}},
                     500
    end

    test "idempotent on :failed: returns row unchanged, no broadcast" do
      {_, port} = start_server()
      {user, network, fresh} = setup_credential(port)
      cred = set_state(fresh, :failed, "old reason")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.network(user.name, network.slug))

      assert {:ok, returned} = Networks.mark_failed(cred, "new reason")
      assert returned.connection_state == :failed
      assert returned.connection_state_reason == "old reason"

      refute_receive {:connection_state_changed, _}, 100
    end

    test "rejects from :parked: returns {:error, :user_parked}" do
      {_, port} = start_server()
      {_, _, fresh} = setup_credential(port)
      cred = set_state(fresh, :parked, "user wants out")

      assert {:error, :user_parked} = Networks.mark_failed(cred, "k-line: trial")

      reloaded = reload(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.connection_state_reason == "user wants out"
    end
  end

  describe "Credentials.list_credentials_for_all_users/0 — filter on :connected" do
    test "returns only :connected credentials, skips :parked + :failed" do
      {_, port} = start_server()
      {_, _, cred_connected} = setup_credential(port)
      {_, _, cred_parked} = setup_credential(port)
      {_, _, cred_failed} = setup_credential(port)
      _ = set_state(cred_parked, :parked, "manual")
      _ = set_state(cred_failed, :failed, "k-line")

      listed = Credentials.list_credentials_for_all_users()
      keys = Enum.map(listed, fn c -> {c.user_id, c.network_id} end)

      assert {cred_connected.user_id, cred_connected.network_id} in keys
      refute {cred_parked.user_id, cred_parked.network_id} in keys
      refute {cred_failed.user_id, cred_failed.network_id} in keys
    end
  end
end
