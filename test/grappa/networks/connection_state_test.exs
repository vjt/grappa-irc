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

  describe "connect/1" do
    test "transitions :parked → :connected, clears reason, broadcasts" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :parked, "manual")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, updated} = Networks.connect(cred)
      assert updated.connection_state == :connected
      assert updated.connection_state_reason == nil
      assert %DateTime{} = updated.connection_state_changed_at

      slug = network.slug
      uid = user.id
      nid = network.id

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         user_id: ^uid,
                         network_id: ^nid,
                         network_slug: ^slug,
                         from: :parked,
                         to: :connected,
                         reason: nil,
                         at: at
                       }
                     },
                     500

      # bnd-A11: timestamps land on the wire as ISO-8601 strings,
      # not raw `%DateTime{}` structs (cic TS contract = string).
      assert is_binary(at)
      assert {:ok, _, 0} = DateTime.from_iso8601(at)

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :connected
      assert reloaded.connection_state_reason == nil
    end

    test "transitions :failed → :connected, clears reason, broadcasts" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failed, "k-line: trial")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, updated} = Networks.connect(cred)
      assert updated.connection_state == :connected
      assert updated.connection_state_reason == nil

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :failed,
                         to: :connected
                       }
                     },
                     500
    end

    test "idempotent on :connected — returns row unchanged, no broadcast" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, cred} = user_with_credential(port, %{})
      assert cred.connection_state == :connected
      original_changed_at = cred.connection_state_changed_at

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, returned} = Networks.connect(cred)
      assert returned.connection_state == :connected
      assert returned.connection_state_reason == cred.connection_state_reason
      assert returned.connection_state_changed_at == original_changed_at

      refute_receive {:connection_state_changed, _}, 100
    end
  end

  describe "disconnect/2" do
    test "from :connected with live session: sends QUIT upstream, terminates session, transitions :parked, broadcasts" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})
      assert cred.connection_state == :connected

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      ref = Process.monitor(pid)

      assert {:ok, updated} = Networks.disconnect(cred, "user-disconnect")

      assert {:ok, "QUIT :user-disconnect\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "QUIT"), 1_000)

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil

      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "user-disconnect"
      assert %DateTime{} = updated.connection_state_changed_at

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :parked,
                         reason: "user-disconnect"
                       }
                     },
                     500
    end

    test "from :connected with no live session: transitions :parked, broadcasts (best-effort QUIT skipped silently)" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, cred} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, updated} = Networks.disconnect(cred, "manual")
      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "manual"

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :parked
                       }
                     },
                     500
    end

    test "from :parked: returns {:error, :not_connected} unchanged" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :parked, "first")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:error, :not_connected} = Networks.disconnect(cred, "second")
      refute_receive {:connection_state_changed, _}, 100

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.connection_state_reason == "first"
    end

    test "from :failed: returns {:error, :not_connected} unchanged" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failed, "k-line: trial")

      assert {:error, :not_connected} = Networks.disconnect(cred, "manual")
      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :failed
      assert reloaded.connection_state_reason == "k-line: trial"
    end
  end

  describe "mark_failed/2" do
    test "from :connected with live session: terminates session, transitions :failed, broadcasts" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      ref = Process.monitor(pid)

      assert {:ok, updated} = Networks.mark_failed(cred, "k-line: G:Lined")

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil

      assert updated.connection_state == :failed
      assert updated.connection_state_reason == "k-line: G:Lined"

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :failed,
                         reason: "k-line: G:Lined"
                       }
                     },
                     500
    end

    test "idempotent on :failed: returns row unchanged, no broadcast" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failed, "old reason")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, returned} = Networks.mark_failed(cred, "new reason")
      assert returned.connection_state == :failed
      assert returned.connection_state_reason == "old reason"

      refute_receive {:connection_state_changed, _}, 100
    end

    test "rejects from :parked: returns {:error, :user_parked}" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :parked, "user wants out")

      assert {:error, :user_parked} = Networks.mark_failed(cred, "k-line: trial")

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.connection_state_reason == "user wants out"
    end
  end

  # #2474 — the server parks a row whose session it stopped and could not
  # bring back. The away half (it is kept, unlike `disconnect/2`) lives in
  # `Grappa.Networks.AwayTest` beside the rest of #417.
  describe "mark_parked/2" do
    test "from :connected with live session: terminates session, transitions :parked, broadcasts" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      ref = Process.monitor(pid)

      assert {:ok, updated} = Networks.mark_parked(cred, "restart refused")

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil

      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "restart refused"
      assert reload_credential(cred).connection_state == :parked

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :parked,
                         reason: "restart refused"
                       }
                     },
                     500
    end

    test "from :failing: parks it, so a backoff ladder cannot outlive the park" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "connection refused")

      assert {:ok, %Credential{connection_state: :parked}} = Networks.mark_parked(cred, "restart refused")
      assert reload_credential(cred).connection_state == :parked
    end

    test "idempotent on :parked and :failed: row unchanged, no broadcast" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for {state, reason} <- [parked: "user wants out", failed: "k-line: trial"] do
        cred = set_state(fresh, state, reason)

        assert {:ok, %Credential{connection_state: ^state}} = Networks.mark_parked(cred, "restart refused")

        reloaded = reload_credential(cred)
        assert reloaded.connection_state == state
        assert reloaded.connection_state_reason == reason
      end

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :connection_state_changed}}, 100
    end

    test "idempotent arm still stops a session the row disagrees with" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, fresh} = user_with_credential(port, %{})
      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      ref = Process.monitor(pid)
      cred = set_state(fresh, :parked, "user wants out")

      assert {:ok, %Credential{connection_state: :parked}} = Networks.mark_parked(cred, "restart refused")

      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
      assert Session.whereis({:user, user.id}, network.id) == nil
      assert reload_credential(cred).connection_state_reason == "user wants out"
    end
  end

  # #1675 — the non-terminal half of the pair. `mark_failed/2` above stops
  # the session and is terminal; these two say "the link is not registered"
  # / "it is" WITHOUT touching the session, so the reconnect ladder keeps
  # running underneath and the row stops claiming a registration that never
  # happened.
  describe "mark_failing/2" do
    test "from :connected: writes :failing + the cause, LEAVES the session alive, broadcasts" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 1_000)

      assert {:ok, updated} = Networks.mark_failing(cred, "connect refused")

      assert updated.connection_state == :failing
      assert updated.connection_state_reason == "connect refused"
      assert %DateTime{} = updated.connection_state_changed_at

      # THE distinguishing property vs mark_failed/2: no stop_session. The
      # session must survive so its own backoff ladder can retry — that is
      # why option 1 as filed (`mark_failed/2` + a 001 edge back) could
      # never work: it kills the process that would deliver the 001.
      assert Process.alive?(pid)
      assert Session.whereis({:user, user.id}, network.id) == pid

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :connected,
                         to: :failing,
                         reason: "connect refused"
                       }
                     },
                     500

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "idempotent on :failing: keeps the FIRST cause, no write, no broadcast" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "tls: hostname mismatch")
      original_changed_at = cred.connection_state_changed_at

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, returned} = Networks.mark_failing(cred, "connect timeout")
      assert returned.connection_state == :failing
      assert returned.connection_state_reason == "tls: hostname mismatch"
      assert returned.connection_state_changed_at == original_changed_at

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :connection_state_changed}}, 100

      reloaded = reload_credential(cred)
      assert reloaded.connection_state_reason == "tls: hostname mismatch"
    end

    test "rejects from :parked — a user park outranks a server-observed failure" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :parked, "user wants out")

      assert {:error, :user_parked} = Networks.mark_failing(cred, "connect refused")

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.connection_state_reason == "user wants out"
    end

    test "rejects from :failed — terminal does not decay into non-terminal" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failed, "k-line: G:Lined")

      assert {:error, :terminal} = Networks.mark_failing(cred, "connect refused")

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :failed
      assert reloaded.connection_state_reason == "k-line: G:Lined"
    end
  end

  describe "mark_registered/1" do
    test "from :failing: back to :connected with the cause CLEARED, broadcasts" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "connect refused")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, updated} = Networks.mark_registered(cred)
      assert updated.connection_state == :connected
      assert updated.connection_state_reason == nil

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :connection_state_changed,
                         from: :failing,
                         to: :connected,
                         reason: nil
                       }
                     },
                     500

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :connected
      assert reloaded.connection_state_reason == nil
    end

    test "idempotent on :connected — 001 fires on every reconnect, so this must not write" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, cred} = user_with_credential(port, %{})
      original_changed_at = cred.connection_state_changed_at

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, returned} = Networks.mark_registered(cred)
      assert returned.connection_state == :connected
      assert returned.connection_state_changed_at == original_changed_at

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :connection_state_changed}}, 100
    end

    test "rejects from :parked and :failed — neither is wanted-up" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, a} = user_with_credential(port, %{})
      {_, _, b} = user_with_credential(port, %{})

      assert {:error, :not_failing} = Networks.mark_registered(set_state(a, :parked, "manual"))
      assert {:error, :not_failing} = Networks.mark_registered(set_state(b, :failed, "k-line"))
    end
  end

  describe "the three existing verbs against the new state (#1675)" do
    test "disconnect/2 parks a :failing row — the operator must be able to stop a hammering network" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "connect refused")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, updated} = Networks.disconnect(cred, "stop it")
      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "stop it"

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :connection_state_changed, from: :failing, to: :parked}
                     },
                     500
    end

    test "mark_failed/2 escalates a :failing row to terminal" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "connect refused")

      assert {:ok, updated} = Networks.mark_failed(cred, "k-line: G:Lined")
      assert updated.connection_state == :failed
      assert updated.connection_state_reason == "k-line: G:Lined"
    end

    test "connect/1 is a no-op on :failing — the row is already wanted-up, and it is NOT registered" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, _, fresh} = user_with_credential(port, %{})
      cred = set_state(fresh, :failing, "connect refused")

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, returned} = Networks.connect(cred)
      assert returned.connection_state == :failing
      assert returned.connection_state_reason == "connect refused"

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :connection_state_changed}}, 100
    end
  end

  # #1675 — the door `Session.Server` reaches through its injected closure.
  # Subject-polymorphic on purpose: the write set of `connection_state` has
  # no subject branch, so a user-only door would leave the visitor half of
  # the same column lying in exactly the way this issue is about.
  describe "report_link_state/3" do
    test "{:failing, reason} then :registered, for a USER credential" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})

      assert :ok =
               Networks.report_link_state({:user, user.id}, network.id, {:failing, "no route"})

      assert reload_credential(cred).connection_state == :failing

      assert :ok = Networks.report_link_state({:user, user.id}, network.id, :registered)

      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :connected
      assert reloaded.connection_state_reason == nil
    end

    test "{:failing, reason} then :registered, for a VISITOR credential" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, network, _} = user_with_credential(port, %{})
      visitor = visitor_fixture(network_slug: network.slug)
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert cred.connection_state == :connected

      assert :ok =
               Networks.report_link_state(
                 {:visitor, visitor.id},
                 network.id,
                 {:failing, "connect refused"}
               )

      {:ok, failing} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert failing.connection_state == :failing
      assert failing.connection_state_reason == "connect refused"

      assert :ok = Networks.report_link_state({:visitor, visitor.id}, network.id, :registered)

      {:ok, back} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert back.connection_state == :connected
      assert back.connection_state_reason == nil
    end

    test "a deleted credential is a logged no-op, never a crash" do
      {_, network, _} = user_with_credential(IRCServer.pick_unused_port(), %{})

      assert :ok =
               Networks.report_link_state(
                 {:user, Ecto.UUID.generate()},
                 network.id,
                 {:failing, "gone"}
               )
    end
  end

  describe "Credentials.list_credentials_for_all_users/0 — the boot set" do
    test "returns :connected AND :failing, skips :parked + :failed" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {_, _, cred_connected} = user_with_credential(port, %{})
      {_, _, cred_parked} = user_with_credential(port, %{})
      {_, _, cred_failed} = user_with_credential(port, %{})
      {_, _, cred_failing} = user_with_credential(port, %{})
      _ = set_state(cred_parked, :parked, "manual")
      _ = set_state(cred_failed, :failed, "k-line")
      _ = set_state(cred_failing, :failing, "connect refused")

      listed = Credentials.list_credentials_for_all_users()
      keys = Enum.map(listed, fn c -> {c.user_id, c.network_id} end)

      assert {cred_connected.user_id, cred_connected.network_id} in keys
      # #1675 point 4 — a reboot inside a backoff window must NOT drop the
      # network for good. `:failed` stays skipped (terminal, operator acts);
      # `:failing` is resumed, which is the whole reason they are two values.
      assert {cred_failing.user_id, cred_failing.network_id} in keys
      refute {cred_parked.user_id, cred_parked.network_id} in keys
      refute {cred_failed.user_id, cred_failed.network_id} in keys
    end
  end
end
