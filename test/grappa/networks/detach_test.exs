defmodule Grappa.Networks.DetachTest do
  @moduledoc """
  issue 2219 — `Grappa.Networks.{detach/2, reattach/1}` and the
  attachment axis they write.

  `POST /session/networks` accretes a network; nothing took one back. The
  rail has hidden a parked network since #1985, but `$home` kept listing
  it and the credential kept everything the subject had authored, so
  "I joined the wrong network" had no answer short of `DELETE /me`.

  What these tests pin is the pair of properties the column exists for:
  a detached network stops being one of the subject's networks EVERYWHERE
  a subject-facing reader looks, and it loses NOTHING — the nick, the
  SASL user, the encrypted secrets and the autojoin set are all still
  there when it comes back. A test that only checked the first half would
  pass just as happily against an unbind, which is the verb this one is
  not.

  `async: false`: `SessionRegistry`, `SessionSupervisor` and `PubSub` are
  singletons, and the live-session arm drives all three.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, Repo, Session}
  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.PubSub.Topic

  # Everything a subject can author on a credential, set to values that
  # could not survive by accident. The point of the reversible verb is
  # that this map is intact on the far side, so the fixture states it
  # once and both the detach and the reattach arms assert against it.
  @authored %{
    nick: "peluche",
    ident: "pel",
    realname: "Peluche Test",
    sasl_user: "peluche-sasl",
    password: "s3cret-nickserv",
    auth_method: :sasl,
    autojoin_channels: ["#sbiffo", "#grappa"]
  }

  defp assert_authored_intact(%Credential{} = cred) do
    assert cred.nick == @authored.nick
    assert cred.ident == @authored.ident
    assert cred.realname == @authored.realname
    assert cred.sasl_user == @authored.sasl_user
    assert cred.auth_method == @authored.auth_method
    assert cred.autojoin_channels == @authored.autojoin_channels
    # The Cloak round-trip: the SECRET is what an unbind would have taken.
    assert is_binary(cred.password_encrypted)
    assert byte_size(cred.password_encrypted) > 0
  end

  defp park(%Credential{} = cred) do
    cred
    |> Ecto.Changeset.change(%{
      connection_state: :parked,
      connection_state_reason: "manual",
      connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
    })
    |> Repo.update!()
  end

  describe "detach/2" do
    test "marks the credential detached and keeps every authored field" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      cred = park(fresh)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, detached} = Networks.detach(cred, "detaching network")
      assert %DateTime{} = detached.detached_at

      slug = network.slug
      nid = network.id

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :network_detached,
                         network_id: ^nid,
                         network_slug: ^slug
                       }
                     },
                     500

      # The row is still there, whole. This is the assertion that
      # separates this verb from `Credentials.unbind_credential/2`.
      assert {:ok, reloaded} = Credentials.get_credential_by_ids(user.id, network.id)
      assert %DateTime{} = reloaded.detached_at
      assert_authored_intact(reloaded)
    end

    test "a detached network leaves every subject-facing reader" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      cred = park(fresh)

      assert Credentials.list_credentials_for_user(user) != []
      {:ok, _} = Networks.detach(cred, "detaching network")

      assert Credentials.list_credentials_for_user(user) == []
      assert Credentials.list_networks_for_subject({:user, user.id}) == []

      # The boot set: a detached binding must never spawn a session the
      # subject cannot see, stop or reconnect.
      boot_ids = Enum.map(Credentials.list_credentials_for_all_users(), & &1.network_id)
      refute network.id in boot_ids

      # And the honesty breakdown that reports on that set counts it
      # nowhere rather than filing it under `:parked`.
      assert Credentials.count_by_state().parked == 0
    end

    test "the admin door still sees it; the subject-facing reader does not" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      {:ok, _} = Networks.detach(park(fresh), "detaching network")

      # `Admin.CredentialsController.delete/2` resolves through this one.
      # If it were filtered, an operator could no longer unbind the row a
      # subject had put out of its own sight.
      assert {:ok, %Credential{}} = Credentials.get_credential(user, network)
      assert {:error, :not_found} = Credentials.get_attached_credential(user, network)

      # The operator listing keeps it, and says why it is inert.
      assert [%Credential{detached_at: %DateTime{}}] =
               Enum.filter(Credentials.list_all_credentials(), &(&1.user_id == user.id))
    end

    test "listed for the re-attach offer, with its network preloaded" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      {:ok, _} = Networks.detach(park(fresh), "detaching network")

      # `home_data_for_user/1` reads the whole partition once and splits it
      # here rather than asking twice — the boot cost is a pinned constant
      # (#1679), so this is the shape the offer list is built from.
      assert [%Credential{network: %{slug: slug}}] =
               user.id
               |> Credentials.list_every_credential_for_user_id()
               |> Enum.reject(&is_nil(&1.detached_at))

      assert slug == network.slug
    end

    test "parks and quits a LIVE network before it marks the row" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, @authored)
      assert cred.connection_state == :connected

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      :ok = IRCServer.welcome(server, 1_000)
      ref = Process.monitor(pid)

      assert {:ok, detached} = Networks.detach(cred, "detaching network")

      # The upstream is told, rather than having the socket yanked.
      assert {:ok, quit} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "QUIT"), 1_000)

      assert quit =~ "QUIT :detaching network"

      # Mark-then-park would have left this pid alive behind a binding no
      # subject-facing reader returns — a session nobody can reach.
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil
      assert detached.connection_state == :parked
      assert %DateTime{} = detached.detached_at
    end

    test "a FAILED network is parked too, and the move is announced" do
      {user, network, fresh} = user_with_credential(6667, @authored)

      failed =
        fresh
        |> Ecto.Changeset.change(%{
          connection_state: :failed,
          connection_state_reason: "k-line: trial",
          connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
        })
        |> Repo.update!()

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, detached} = Networks.detach(failed, "detaching network")

      # Rest state is `:parked` from EVERY arm, so a re-attach never resumes
      # carrying a failure the subject already chose to put away.
      assert detached.connection_state == :parked
      assert %DateTime{} = detached.detached_at

      # And the move is BROADCAST, which is not bookkeeping: `networkParked.ts`
      # keeps a failed network IN the sidebar on purpose, so the operator may
      # be looking at a window on it, and this event is what redirects them
      # home before the row goes.
      nid = network.id

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{
                         kind: :connection_state_changed,
                         network_id: ^nid,
                         from: :failed,
                         to: :parked
                       }
                     },
                     500

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :network_detached, network_id: ^nid}
                     },
                     500
    end

    test "an ALREADY-PARKED row with a live session still has it stopped" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, @authored)

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      ref = Process.monitor(pid)

      # The column says parked while the pid is alive. That disagreement is
      # NOT hypothetical bookkeeping — CLAUDE.md names DB state and live state
      # as separate sources of truth, and `unbind_credential/2` stops
      # unconditionally for exactly this reason. Gating the stop on the state
      # would hide this session behind a binding no reader returns.
      parked = park(cred)
      assert is_pid(Grappa.Session.whereis({:user, user.id}, network.id))

      assert {:ok, detached} = Networks.detach(parked, "detaching network")

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Grappa.Session.whereis({:user, user.id}, network.id) == nil
      assert %DateTime{} = detached.detached_at
    end

    test "re-detaching an already-detached network succeeds and re-broadcasts" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      {:ok, first} = Networks.detach(park(fresh), "detaching network")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      assert {:ok, second} = Networks.detach(first, "detaching network")
      assert %DateTime{} = second.detached_at

      # A second tab that has not yet seen the first detach needs the
      # event more than the initiator does.
      nid = network.id
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :network_detached, network_id: ^nid}}, 500
    end
  end

  describe "reattach/1" do
    test "clears the column and hands back everything that was authored" do
      {user, network, fresh} = user_with_credential(6667, @authored)
      {:ok, detached} = Networks.detach(park(fresh), "detaching network")

      assert {:ok, revived} = Networks.reattach(detached)
      assert revived.detached_at == nil
      assert_authored_intact(revived)

      # Back in the subject's own listings, and out of the offer list.
      assert [%Credential{}] = Credentials.list_credentials_for_user(user)
      assert Enum.all?(Credentials.list_every_credential_for_user_id(user.id), &is_nil(&1.detached_at))
      assert {:ok, %Credential{}} = Credentials.get_attached_credential(user, network)
    end

    test "comes back :parked — the shape the accretion door's spawn expects" do
      {_, _, fresh} = user_with_credential(6667, @authored)
      {:ok, detached} = Networks.detach(park(fresh), "detaching network")

      assert {:ok, revived} = Networks.reattach(detached)
      assert revived.connection_state == :parked
    end
  end
end
