defmodule Grappa.AccountDeletionTest do
  @moduledoc """
  #157 — self-service account deletion. The subject-routed
  teardown→wipe verb behind `DELETE /me`.

  Asserts the VISIBLE outcomes, not the call sequence: live session(s)
  stopped, the parent row gone, the cascade dependents (auth sessions +
  scrollback) gone, and the gating (admin user / anon visitor → forbidden,
  row PRESERVED).

  ## The #126 boundary

  `quit` PRESERVES a registered visitor's row (detach no-ops
  `purge_if_anon`); `delete_account` WIPES it. Both are asserted so the
  distinction can't silently collapse into "quit also nukes."

  `async: false` because every test spawns a `Session.Server` under the
  singleton `Grappa.SessionSupervisor` + `Grappa.SessionRegistry`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AccountDeletion, Accounts, AdmissionStateHelpers, Scrollback, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Credentials
  alias Grappa.Scrollback.Message
  alias Grappa.Visitors
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

  defp await_handshake(server) do
    {:ok, _} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 5_000)
    :ok
  end

  # A registered visitor = identified on some network. #211 phase 7 —
  # `commit_password/3` writes the per-network secret + flips the credential's
  # `auth_method` to `:nickserv_identify`; registration is DERIVED from that
  # (`Credentials.visitor_registered?/1`), NOT a `visitors.expires_at`-nil flag.
  defp registered_visitor(port) do
    {visitor, network} = visitor_with_network(port)
    {:ok, _} = Visitors.commit_password(visitor.id, network.id, "s3cret")
    {Repo.get!(Visitor, visitor.id), network}
  end

  defp seed_message(opts) do
    {:ok, message} =
      Scrollback.persist_event(%{
        user_id: Keyword.get(opts, :user_id),
        visitor_id: Keyword.get(opts, :visitor_id),
        network_id: Keyword.fetch!(opts, :network_id),
        channel: "#sniffo",
        server_time: System.system_time(:millisecond),
        kind: :privmsg,
        sender: "someone",
        body: "scrollback that must die with the account",
        meta: %{}
      })

    message.id
  end

  describe "delete_account/1 — user" do
    test "non-admin user: stops every live session, deletes the row + cascade deps" do
      {server1, port1} = start_irc_server()
      {server2, port2} = start_irc_server()

      user = user_fixture(is_admin: false)
      {network1, _} = network_with_server(port: port1)
      {network2, _} = network_with_server(port: port2)
      _ = credential_fixture(user, network1)
      _ = credential_fixture(user, network2)

      pid1 = start_session_for(user, network1)
      pid2 = start_session_for(user, network2)
      :ok = await_handshake(server1)
      :ok = await_handshake(server2)
      ref1 = Process.monitor(pid1)
      ref2 = Process.monitor(pid2)

      session = session_fixture(user)
      message_id = seed_message(user_id: user.id, network_id: network1.id)

      assert :ok = AccountDeletion.delete_account({:user, user})

      # Both live sessions torn down.
      assert_receive {:DOWN, ^ref1, :process, ^pid1, _}, 1_000
      assert_receive {:DOWN, ^ref2, :process, ^pid2, _}, 1_000
      assert Session.whereis({:user, user.id}, network1.id) == nil
      assert Session.whereis({:user, user.id}, network2.id) == nil

      # Parent row gone …
      assert Repo.get(User, user.id) == nil
      # … cascade: auth session unusable + scrollback wiped.
      assert {:error, :not_found} = Accounts.authenticate(session.id)
      assert Repo.get(Message, message_id) == nil
    end

    test "admin user: forbidden, the row is PRESERVED" do
      user = user_fixture(is_admin: true)

      assert {:error, :forbidden} = AccountDeletion.delete_account({:user, user})
      assert %User{} = Repo.get(User, user.id)
    end
  end

  describe "delete_account/1 — visitor" do
    test "registered visitor: stops the session, deletes the row + cascade deps" do
      {server, port} = start_irc_server()
      {visitor, network} = registered_visitor(port)

      pid = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)
      ref = Process.monitor(pid)

      session = visitor_session_fixture(visitor)
      message_id = seed_message(visitor_id: visitor.id, network_id: network.id)

      assert :ok = AccountDeletion.delete_account({:visitor, visitor})

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 1_000
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) == nil
      assert {:error, :not_found} = Accounts.authenticate(session.id)
      assert Repo.get(Message, message_id) == nil
    end

    test "anon visitor: forbidden, the row is PRESERVED (quit-only; mirrors require_registered_visitor)" do
      visitor = visitor_fixture(network_slug: "azzurra-#{System.unique_integer([:positive])}")
      # #211 phase 7 — anon ⟺ NOT registered (registration is DERIVED from
      # the credentials: holds ≥1 committed NickServ secret). An anon
      # visitor holds only anon (`auth_method: :none`) credentials.
      refute Credentials.visitor_registered?(visitor.id)

      assert {:error, :forbidden} = AccountDeletion.delete_account({:visitor, visitor})
      assert %Visitor{} = Repo.get(Visitor, visitor.id)
    end
  end

  describe "the #126 boundary — quit preserves, delete wipes" do
    test "a registered visitor's row SURVIVES detach (quit) but is WIPED by delete_account" do
      {_, port} = start_irc_server()

      # Detach (the quit composite's web-revoke leg) no-ops purge_if_anon
      # for a registered identity — the row survives.
      {survivor, _} = registered_visitor(port)
      :ok = Visitors.purge_if_anon(survivor.id)
      # #211 phase 7 — registered ⟺ Credentials.visitor_registered?/1 (the
      # row survived the anon-only purge because it holds a NickServ cred).
      assert %Visitor{} = Repo.get(Visitor, survivor.id)
      assert Credentials.visitor_registered?(survivor.id)

      # delete_account on an equivalent registered visitor WIPES the row.
      {doomed, _} = registered_visitor(port)
      assert :ok = AccountDeletion.delete_account({:visitor, doomed})
      assert Repo.get(Visitor, doomed.id) == nil
    end
  end
end
