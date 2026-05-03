defmodule Grappa.Visitors.LoginTest do
  @moduledoc """
  Synchronous login orchestrator (Task 9) — exercises the W10/W11/W12/W13
  privacy decision tree. async: false because the IRCServer fake's TCP
  listen socket plus the singleton Grappa.SessionRegistry serialize across
  tests; aligns with `server_test.exs`'s same choice.

  Each test that spawns a Session.Server explicitly tears it down via
  `Grappa.Session.stop_session/2` (or via Login's own teardown on the
  failure paths). Without the explicit stop the GenServer outlives the
  test and the next test's registry lookup races the dying child.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, IRCServer, Repo, Session, Visitors}
  alias Grappa.Accounts.Session, as: AccountsSession
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Networks.Network
  alias Grappa.Visitors.{Login, Visitor}

  # NetworkCircuit is ETS-backed and survives Ecto sandbox resets. Each
  # test that creates a network may get the same auto-increment id (sqlite
  # resets the sequence per sandbox transaction). Clear the circuit table
  # before every test so a failure recorded in one test doesn't bleed into
  # the next test's fresh network-row with the same integer id.
  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end

  defp setup_visitor_network(port) do
    network_with_server(port: port, slug: "azzurra")
  end

  defp feed_001(server, nick) do
    IRCServer.feed(server, ":irc.test.org 001 #{nick} :Welcome\r\n")
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  defp login_input(overrides \\ %{}) do
    Map.merge(
      %{nick: "vjt", password: nil, ip: "1.2.3.4", user_agent: "ua", token: nil, captcha_token: nil, client_id: nil},
      overrides
    )
  end

  defp stop_visitor_session(visitor_id, network_id) do
    :ok = Session.stop_session({:visitor, visitor_id}, network_id)
  end

  describe "validation gates (independent of network state)" do
    test "malformed nick → {:error, :malformed_nick}" do
      assert {:error, :malformed_nick} = Login.login(login_input(%{nick: "9bad"}))
    end

    test "no Network row for the configured slug → {:error, :network_unconfigured}" do
      # No network_with_server call — slug "azzurra" isn't in the DB.
      assert {:error, :network_unconfigured} = Login.login(login_input())
    end
  end

  describe "case 1 — no visitor row (anon provisioning)" do
    test "spawns session, awaits 001, creates accounts_session, returns {:ok, %{visitor, token}}" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input()) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v, token: token}} = Task.await(task, 10_000)
      assert v.nick == "vjt"
      assert v.network_slug == "azzurra"
      assert is_nil(v.password_encrypted)
      assert is_binary(token)

      assert {:ok, %AccountsSession{visitor_id: vid}} = Accounts.authenticate(token)
      assert vid == v.id

      stop_visitor_session(v.id, network.id)
    end

    test "connect refused → {:error, :upstream_unreachable}, anon row purged" do
      port = pick_unused_port()
      {_, _} = setup_visitor_network(port)

      assert {:error, :upstream_unreachable} = Login.login(login_input())
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "no 001 within budget → {:error, :timeout}, session torn down + anon row purged" do
      {_, port} = start_server()
      {_, _} = setup_visitor_network(port)

      assert {:error, :timeout} = Login.login(login_input(), login_timeout_ms: 200)
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "no SessionPlan server row → {:error, :no_server}, anon row purged" do
      # No Server row means SessionPlan.resolve fails with :no_server.
      {:ok, network} = Grappa.Networks.find_or_create_network(%{slug: "azzurra"})
      _ = network

      assert {:error, :no_server} = Login.login(login_input())
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end
  end

  describe "case 2 — registered visitor (password gate)" do
    setup do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, anon} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(anon.id, "s3cret")

      on_exit(fn -> stop_visitor_session(registered.id, network.id) end)

      {:ok, server: server, network: network, visitor: registered}
    end

    test "missing password → {:error, :password_required}" do
      assert {:error, :password_required} = Login.login(login_input())
    end

    test "wrong password → {:error, :password_mismatch}" do
      assert {:error, :password_mismatch} =
               Login.login(login_input(%{password: "wrong"}))
    end

    test "matching password → preempt prior sessions, fresh token, IDENTIFY sent post-001",
         %{server: server, visitor: visitor} do
      # Plant a prior session so we can verify it's revoked post-preempt.
      {:ok, prior} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

      task = Task.async(fn -> Login.login(login_input(%{password: "s3cret"})) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      # Login sends `PRIVMSG NickServ :IDENTIFY s3cret` after readiness.
      {:ok, identify_line} =
        IRCServer.wait_for_line(
          server,
          &String.contains?(&1, "PRIVMSG NickServ :IDENTIFY s3cret")
        )

      assert String.starts_with?(identify_line, "PRIVMSG NickServ :IDENTIFY ")

      assert {:ok, %{visitor: returned_visitor, token: new_token}} =
               Task.await(task, 10_000)

      assert returned_visitor.id == visitor.id

      # Prior token revoked, new resolves.
      assert {:error, :revoked} = Accounts.authenticate(prior.id)
      assert {:ok, _} = Accounts.authenticate(new_token)
    end
  end

  describe "case 3 — anon collision (token gate)" do
    setup do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, prior} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      {:ok, network: network, visitor: visitor, token: prior.id}
    end

    test "valid token for THIS visitor → reuse: rotate token, no respawn", %{
      visitor: visitor,
      token: token
    } do
      assert {:ok, %{visitor: returned, token: new_token}} =
               Login.login(login_input(%{token: token}))

      assert returned.id == visitor.id
      refute new_token == token

      assert {:error, :revoked} = Accounts.authenticate(token)
      assert {:ok, _} = Accounts.authenticate(new_token)
    end

    test "no token → {:error, :anon_collision}" do
      assert {:error, :anon_collision} = Login.login(login_input())
    end

    test "token resolves to a different visitor → {:error, :anon_collision}" do
      {:ok, alice} = Visitors.find_or_provision_anon("alice", "azzurra", "5.6.7.8")
      {:ok, alice_session} = Accounts.create_session({:visitor, alice.id}, "5.6.7.8", "ua")

      assert {:error, :anon_collision} =
               Login.login(login_input(%{nick: "vjt", token: alice_session.id}))
    end

    test "malformed token → {:error, :anon_collision}" do
      assert {:error, :anon_collision} =
               Login.login(login_input(%{token: "not-a-uuid"}))
    end
  end

  describe "capacity gates" do
    setup do
      # Clear circuit state between tests so prior failures don't bleed.
      for {key, _, _, _, _} <- NetworkCircuit.entries(),
          do: :ets.delete(:admission_network_circuit_state, key)

      # Use the visitor network slug ("azzurra") so Login.login's
      # visitor_network() lookup succeeds. No IRC server needed — capacity
      # checks hit DB + ETS only and do not spawn sessions.
      network = network_fixture(slug: "azzurra")
      {:ok, network: network}
    end

    test "client_cap_exceeded → {:error, :client_cap_exceeded}", %{network: net} do
      # Pin the per-(client, network) cap at 1 via the network's
      # max_per_client column (the operator's knob — Plan 1 schema).
      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      # Seed one existing visitor + accounts_sessions row for client_id
      # "device-a" on this network. Use direct fixture verbs, not
      # Login.login, to avoid spinning a real Session.Server.
      {:ok, existing_visitor} =
        Visitors.find_or_provision_anon("old_user", capped_net.slug, "1.2.3.4")

      {:ok, _} =
        Accounts.create_session(
          {:visitor, existing_visitor.id},
          "1.2.3.4",
          nil,
          client_id: "device-a"
        )

      # Second login attempt from same client_id on same network should
      # fail at the admission gate, before any spawn attempt.
      result =
        Login.login(%{
          nick: "second_user",
          password: nil,
          ip: "1.2.3.4",
          user_agent: nil,
          token: nil,
          captcha_token: nil,
          client_id: "device-a"
        })

      assert result == {:error, :client_cap_exceeded}
    end

    test "network_cap_exceeded → {:error, :network_cap_exceeded}", %{network: net} do
      # Task 4 changeset rejects max_concurrent_sessions: 0.
      # Use cap=1 + register one fake live-session entry in SessionRegistry
      # so Registry.count_select returns 1, tripping the cap. The fake key
      # MUST go through `Server.registry_key/2` so the match-spec in
      # `count_live_sessions/1` actually matches — registering a hand-rolled
      # tuple bypasses the production registrar and makes the test pass
      # while encoding the bug.
      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_concurrent_sessions: 1})
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          Grappa.SessionRegistry,
          Session.Server.registry_key({:visitor, "fake-vid"}, capped_net.id),
          nil
        )

      result =
        Login.login(%{
          nick: "any_nick",
          password: nil,
          ip: "1.2.3.4",
          user_agent: nil,
          token: nil,
          captcha_token: nil,
          client_id: "device-a"
        })

      assert result == {:error, :network_cap_exceeded}
    end

    test "network_circuit_open → {:error, :network_circuit_open}", %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      # Flush GenServer cast queue before checking.
      _ = :sys.get_state(NetworkCircuit)

      result =
        Login.login(%{
          nick: "fresh",
          password: nil,
          ip: "1.2.3.4",
          user_agent: nil,
          token: nil,
          captcha_token: nil,
          client_id: "device-a"
        })

      assert result == {:error, :network_circuit_open}
    end
  end
end
