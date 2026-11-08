defmodule Grappa.Session.E2eSessionTest do
  @moduledoc """
  issue 2430 — end-to-end encrypted query lines through a REAL session.

  Same reason `Grappa.Session.DccIntakeTest` drives a real session:
  `apply_effects/2` has no catch-all, so an effect the router emits and
  the server cannot match kills the session. And this arm is reachable by
  any nick on the network with no opt-in — a line to our nick is the whole
  surface. Every test here feeds real lines into a real `Session.Server`
  over a real socket (`Grappa.IRCServer`) and reads what came out: the
  user-topic event, the lines on the wire, and the `messages` table.

  The headline property is the spec's: an E2E line is never stored. Each
  inbound test therefore ends by counting EVERY row on the network, not
  the rows of one window — a row filed under a window nobody thought to
  look in is still a stored line.

  Wire v2 (multi-device): every subject here holds a real E2E identity — a
  master, devices with real keys, a signed list (`Grappa.E2eFixtures`) —
  because grappa routes inbound lines to listed devices only, sends only
  from a listed device, and answers a KEYREQ with a KEYS it composes from
  them.

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor` and `Grappa.PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures
  import Grappa.PushFixtures, only: [stored_subscription!: 2]

  alias Grappa.{E2eFixtures, E2eInbox, E2eKeys, E2eRequests, IRCServer, QueryWindows, Repo, Session}
  alias Grappa.E2eRequests.Request
  alias Grappa.IRC.{Client, E2e, Identifier, LineSplit}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Message
  alias Grappa.Session.{Backoff, E2eKeyAnswers, E2ePacer, E2eReassembly}

  @nick "grappa-test"

  # The peers' devices, as their frames name them.
  @alice "AaZaARRDyBk"
  @bob "BoBBoBBoBBo"

  # A real P-256 client key and auth secret (as in `Grappa.Push.TriggersTest`):
  # the web-push encryption runs on them before anything is sent.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"
  @wire_timeout 1_000

  # A KEYS for several devices drips a line per ~5 s of fake-lag bank, and
  # past the reactive lane's budget for one peer (`E2ePacer`) it can wait
  # out the fresh patience first. Measured: the last of two devices' four
  # lines 15 s after the KEYREQ, the first line for four devices 8 s after
  # it. Only a failing test waits this long.
  @keys_timeout 60_000

  # grappa's NACK waits on the fake-lag bank like any line, and right after
  # the handshake the bank still holds the registration's cost.
  @nack_timeout 10_000

  # Compact JSON text, what a v2 frame carries; big enough to need several
  # lines on a 512-byte wire.
  defp payload(bytes), do: ~s({"v":2,"body":"#{Base.encode64(:crypto.strong_rand_bytes(bytes))}"})

  @small ~s({"v":2})

  # A channel (v3 group) payload, what a Megolm-style channel message
  # carries; grappa never parses it, so the body is a placeholder.
  @group_small ~s({"v":3,"ch":"#grappa","sid":"s1","i":0,"body":"AAAA"})

  describe "inbound" do
    test "a multi-line message reaches the user topic whole, for the device it names, and nothing is stored" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      payload = payload(900)
      lines = lines_from("alice", :pkmsg, "q83vEjRWeJA", {@alice, device.did}, payload)
      assert length(lines) > 1

      Enum.each(lines, &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message} = event}, @wire_timeout

      # The id is the queue's: the device acknowledges it, and a redelivery
      # carries the same one.
      assert [%E2eInbox.Entry{id: id, payload: ^payload}] = E2eInbox.list(device, 0)

      assert event == %{
               kind: :e2e_message,
               id: id,
               network: network.slug,
               from: "alice",
               from_did: @alice,
               to_did: device.did,
               verb: :pkmsg,
               msgid: "q83vEjRWeJA",
               payload: payload,
               own: false,
               channel: nil
             }

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}, 100

      assert Process.alive?(pid)
      assert rows(network) == 0
    end

    test "a message to * is queued once for each listed device, never for one still being paired" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [first] = listed(user, network)
      second = add_listed_device!(subject, network)
      %{device: pairing} = register_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, "*"}, payload(600)), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, to_did: a}}, @wire_timeout
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, to_did: b}}, @wire_timeout
      assert Enum.sort([a, b]) == Enum.sort([first.did, second.did])
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}, 100

      assert [%E2eInbox.Entry{}] = E2eInbox.list(first, 0)
      assert [%E2eInbox.Entry{}] = E2eInbox.list(second, 0)
      assert E2eInbox.list(pairing, 0) == []
    end

    # issue 2491: the sender learns that its message reached none of the
    # devices the subject lists (a peer that moved, a new identity), or it
    # never learns: the device it wrote to is not there to NACK.
    test "a message that reaches no listed device is answered with a NACK from *, naming it, and is not queued" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      %{device: pairing} = register_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for {verb, to} <- [{:msg, pairing.did}, {:pkmsg, "AAAAAAAAAAA"}] do
        msgid = E2e.new_msgid()
        Enum.each(lines_from("alice", verb, msgid, {@alice, to}, @small), &IRCServer.feed(server, &1))

        {:ok, line} = IRCServer.wait_for_line(server, &nack_of?(&1, "alice", msgid), @nack_timeout)
        assert %{from: "*", to: @alice} = fragment_to(line, "alice")
      end

      # A good line last: once ITS event arrives, every line before it has
      # been through the session.
      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "q83vEjRWeJA"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}

      assert Process.alive?(pid)
      assert E2eInbox.list(pairing, 0) == []
      assert [_] = E2eInbox.list(device, 0)
    end

    test "a subject with no listed device NACKs a message to it the same way" do
      {server, pid, _, _} = connected_session(0)
      msgid = E2e.new_msgid()

      Enum.each(lines_from("alice", :pkmsg, msgid, {@alice, "*"}, @small), &IRCServer.feed(server, &1))

      assert {:ok, _} = IRCServer.wait_for_line(server, &nack_of?(&1, "alice", msgid), @nack_timeout)
      assert Process.alive?(pid)
    end

    # Peers draw these NACKs at will: a few nicks writing junk to a device
    # nobody lists must not fill the room the user's own orders need.
    test "NACKs of messages no listed device can read stop at half the connection's urgent and reactive room" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      lane = E2ePacer.max_lane_lines()

      for nick <- ["mal1", "mal2", "mal3"], _ <- 1..lane do
        Enum.each(
          lines_from(nick, :pkmsg, E2e.new_msgid(), {@alice, "AAAAAAAAAAA"}, @small),
          &IRCServer.feed(server, &1)
        )
      end

      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "q83vEjRWeJA"}}, @wire_timeout

      # Each nick's lane holds 32, so three would queue 96 lines.
      waiting = :sys.get_state(pid).e2e_pacer |> E2ePacer.pending() |> length()
      assert waiting > lane
      assert waiting <= div(E2ePacer.max_queued(), 2)
    end

    # A NACK answering a NACK, or a KEYS nobody can read, would loop
    # between two grappas: neither is a message a device could not decrypt.
    test "a NACK or a KEYS that reaches no listed device gets no NACK back" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for {verb, addresses} <- [
            {:nack, {@alice, "AAAAAAAAAAA"}},
            {:nack, {"*", "AAAAAAAAAAA"}},
            {:keys, {"*", "AAAAAAAAAAA"}}
          ] do
        Enum.each(lines_from("alice", verb, E2e.new_msgid(), addresses, @small), &IRCServer.feed(server, &1))
      end

      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "q83vEjRWeJA"}}, @wire_timeout

      # Read in the pacer, not on the wire: a NACK waits there on the bank
      # long after the sync line is through.
      assert E2ePacer.pending(:sys.get_state(pid).e2e_pacer) == []
      refute Enum.any?(IRCServer.sent_lines(server), &match?(%{verb: :nack}, fragment_to(&1, "alice")))
    end

    test "a peer grappa's NACK from * reaches the device it names, from_did *" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      nack = ~s({"ref":"q83vEjRWeJA","v":2})

      Enum.each(lines_from("alice", :nack, "Zm9vYmFyYmE", {"*", device.did}, nack), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_message, verb: :nack, from_did: "*", to_did: to, payload: ^nack}
                     },
                     @wire_timeout

      assert to == device.did
      assert [%E2eInbox.Entry{from_did: "*", verb: :nack}] = E2eInbox.list(device, 0)
    end

    test "malformed, channel and NOTICE E2E lines are dropped and the session survives" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [line] = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small)
      body = line |> String.split(" :", parts: 2) |> List.last()

      IRCServer.feed(
        server,
        ":alice!u@h PRIVMSG #{@nick} :\x01E2E MSG q83vEjRWeJA 0/1 #{@alice} #{device.did} {}\x01\r\n"
      )

      IRCServer.feed(
        server,
        ":alice!u@h PRIVMSG #{@nick} :\x01E2E OFFLINE q83vEjRWeJA 1/1 #{@alice} #{device.did} {}\x01\r\n"
      )

      # A v1 line, which names no device: wire v2 is flag-day.
      IRCServer.feed(server, ":alice!u@h PRIVMSG #{@nick} :\x01E2E MSG q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01\r\n")
      IRCServer.feed(server, ":alice!u@h PRIVMSG #italia :#{body}")
      IRCServer.feed(server, ":alice!u@h NOTICE #{@nick} :#{body}")
      # A good line last: once ITS event arrives, every line before it has
      # been through the session.
      IRCServer.feed(server, line)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, verb: :msg}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
      assert Process.alive?(pid)
      assert rows(network) == 0
    end

    # Channel E2E (protocol v63): a line to a channel we joined is
    # delivered like a DM, with the channel riding the event and the
    # queue row — and, like a DM line, never stored.
    test "a channel E2E message to a channel we joined is delivered with its channel and never stored" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      [line] = channel_lines_from("alice", :msg, "q83vEjRWeJA", {@alice, "*"}, @group_small, "#grappa")
      IRCServer.feed(server, line)

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_message, verb: :msg, channel: "#grappa", from: "alice"}
                     },
                     @wire_timeout

      assert [%E2eInbox.Entry{sender: "alice", channel: "#grappa"}] = E2eInbox.list(device, 0)
      assert Process.alive?(pid)
      assert text_rows(network) == 0
    end

    # Channel E2E (protocol v63): the channel frame has no single
    # recipient — a line to a channel we joined whose frame names a
    # device instead of `*` is malformed and dropped, not delivered to
    # that device alone.
    test "a channel E2E line whose frame names a single device is dropped" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      [line] =
        channel_lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @group_small, "#grappa")

      IRCServer.feed(server, line)

      # A good line last: once ITS event arrives, every line before it
      # has been through the session.
      [good] =
        channel_lines_from("alice", :msg, "q83vEjRWeJB", {@alice, "*"}, @group_small, "#grappa")

      IRCServer.feed(server, good)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "q83vEjRWeJB"}},
                     @wire_timeout

      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
      assert Process.alive?(pid)
      assert [%E2eInbox.Entry{msgid: "q83vEjRWeJB"}] = E2eInbox.list(device, 0)
    end

    # A channel message that spans lines reassembles once and reaches
    # every listed device — the multicast is one message, not one per
    # device, and the queue holds one copy per device.
    test "a multi-line channel E2E message arrives whole on every listed device" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [first] = listed(user, network)
      second = add_listed_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      lines = channel_lines_from("alice", :msg, "q83vEjRWeJA", {@alice, "*"}, payload(800), "#grappa")
      assert length(lines) >= 2
      Enum.each(lines, &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_message, to_did: a, msgid: "q83vEjRWeJA"}
                     },
                     @wire_timeout

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_message, to_did: b, msgid: "q83vEjRWeJA"}
                     },
                     @wire_timeout

      assert Enum.sort([a, b]) == Enum.sort([first.did, second.did])
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}

      assert [%E2eInbox.Entry{channel: "#grappa"}] = E2eInbox.list(first, 0)
      assert [%E2eInbox.Entry{channel: "#grappa"}] = E2eInbox.list(second, 0)
      assert Process.alive?(pid)
      assert text_rows(network) == 0
    end

    # issue 2491, channel half: a channel message that reaches no listed
    # device is answered with a NACK to the sender's nick, the same as a
    # DM — the sender learns nobody on this side can read it.
    test "a channel E2E message that reaches no listed device is answered with a NACK to the sender" do
      {server, pid, _, _} = connected_session(0)
      msgid = E2e.new_msgid()

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      [line] = channel_lines_from("alice", :msg, msgid, {@alice, "*"}, @group_small, "#grappa")
      IRCServer.feed(server, line)

      {:ok, nack_line} = IRCServer.wait_for_line(server, &nack_of?(&1, "alice", msgid), @nack_timeout)
      assert %{from: "*", to: @alice} = fragment_to(nack_line, "alice")
      assert Process.alive?(pid)
    end

    # The queue keys a message on its sender's nick, and refuses a row
    # whose sender is not one. A server prefix, a prefix-less line (`*`)
    # and a sender past the wire-nick byte bound are all reachable from the
    # wire, so they are dropped where the line is routed, not left to kill
    # the session at the queue. (The third used to be "a nick past our
    # 30-character key"; issue 2599 moved the key to the upstream's nick,
    # so a 31-char nick is a sender now — see the test below.)
    test "an E2E line whose sender is not a nick is dropped and the session survives" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [line] = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small)
      body = line |> String.split(" :", parts: 2) |> List.last()

      IRCServer.feed(server, ":irc.example.net PRIVMSG #{@nick} :#{body}")
      IRCServer.feed(server, "PRIVMSG #{@nick} :#{body}")
      too_long = String.duplicate("a", Identifier.max_wire_nick_bytes() + 1)
      IRCServer.feed(server, ":#{too_long}!u@h PRIVMSG #{@nick} :#{body}")
      IRCServer.feed(server, line)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
      assert Process.alive?(pid)
      assert [%E2eInbox.Entry{sender: "alice"}] = E2eInbox.list(device, 0)
    end

    # issue 2599 — the sender's nick is the upstream's call: IRCnet's `foo~`,
    # a collision UID, a nick on a network whose NICKLEN passes 30. The
    # router and the queue take the same rule, so each lands in the queue.
    test "an E2E line from a nick the upstream allows is queued and delivered" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for nick <- ["foo~", "0AAAAAAAB", String.duplicate("a", 31)] do
        Enum.each(lines_from(nick, :msg, E2e.new_msgid(), {@alice, device.did}, @small), &IRCServer.feed(server, &1))
        assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: ^nick}}, @wire_timeout
      end

      assert Process.alive?(pid)
      assert length(E2eInbox.list(device, 0)) == 3
    end
  end

  describe "KEYREQ answered with a KEYS grappa composes" do
    test "a KEYREQ is answered with the signed list and each device's oldest one-time key, from * to the asker" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      identity = identity_of(device)
      [first, _] = otks = [E2eFixtures.signed_key(identity), E2eFixtures.signed_key(identity)]
      {:ok, _} = E2eKeys.upload(device, %{one_time_keys: otks, fallback: E2eFixtures.signed_key(identity)})
      {:ok, list} = E2eKeys.list(subject, network.id)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice", user, network)

      assert %{"v" => 2, "master" => master, "devices" => [entry]} = await_keys(server, "alice", @alice)

      assert master == %{
               "ed25519" => list.master,
               "list" => %{"ver" => 1, "devices" => list.devices},
               "sig" => list.sig
             }

      assert entry["id"] == %{"curve25519" => device.curve25519, "ed25519" => device.ed25519, "sig" => device.sig}
      assert entry["otk"] == %{"key" => first.key, "fallback" => false, "sig" => first.sig}

      assert E2eKeys.status(device) == %{one_time_keys: 1, fallback: true}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, verb: :keyreq}}
      assert [%E2eInbox.Entry{verb: :msg}] = E2eInbox.list(device, 0)
      assert rows(network) == 0
    end

    test "the KEYS covers every listed device that has a key, and no device still being paired" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [first] = listed(user, network)
      second = add_listed_device!(subject, network)
      %{device: pairing} = register_device!(subject, network)
      for device <- [first, second, pairing], do: upload_otks!(device, 1)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice", user, network)

      %{"devices" => entries} = await_keys(server, "alice", @alice)
      assert entries |> Enum.map(& &1["id"]["ed25519"]) |> Enum.sort() == Enum.sort([first.ed25519, second.ed25519])
      assert E2eKeys.status(pairing).one_time_keys == 1
    end

    test "a nick asking again within 15 s is not answered; another nick is, with the next key" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      identity = identity_of(device)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fallback = E2eFixtures.signed_key(identity)
      {:ok, _} = E2eKeys.upload(device, %{one_time_keys: [], fallback: fallback})

      # No one-time key yet: alice gets the fallback key, which leaves her
      # free to take a one-time key next time — unless she asks too soon.
      keyreq!(server, "alice", user, network)
      assert %{"devices" => [%{"otk" => %{"key" => key, "fallback" => true}}]} = await_keys(server, "alice", @alice)
      assert key == fallback.key
      # Recorded as what she got, not what she was allowed: a one-time key
      # stays hers to take once the 15 s are up.
      refute Map.has_key?(:sys.get_state(pid).e2e_key_answers.otk_given, "alice")

      otk = E2eFixtures.signed_key(identity)
      {:ok, _} = E2eKeys.upload(device, %{one_time_keys: [otk], fallback: nil})
      keyreq!(server, "Alice", user, network)
      assert E2eKeys.status(device).one_time_keys == 1

      keyreq!(server, "bob", user, network)
      assert %{"devices" => [%{"otk" => %{"key" => key, "fallback" => false}}]} = await_keys(server, "bob", @alice)
      assert key == otk.key
      assert E2eKeys.status(device).one_time_keys == 0
    end

    test "answers stop at the connection's KEYS budget, however many nicks ask" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      upload_otks!(device, 9)
      asking = for n <- 1..9, do: "peer#{n}"

      # What one answer costs, from the payload and framing the session
      # uses: every nick here has the same length and every key the same
      # size, so every answer costs the same.
      {:ok, payload, _} = E2eKeys.answer(subject, network.id, :otk)
      {:ok, bodies} = E2e.fragment(:keys, E2e.new_msgid(), {"*", @alice}, payload, LineSplit.frame_budget("peer1", 512))
      cost = bodies |> Enum.map(&Client.privmsg_cost_ms("peer1", &1)) |> Enum.sum()
      fit = max(1, div(E2eKeyAnswers.bank_budget_ms(), cost))
      assert fit in 1..8

      Enum.each(asking, &keyreq!(server, &1, user, network))

      assert E2eKeys.status(device).one_time_keys == 9 - fit
    end

    test "the answer is reactive: ahead of the text already waiting for that peer" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      upload_otks!(device, 1)

      # A long text message to alice: its first lines fill the bank, the
      # rest wait on it at about one line per 5 s.
      {:ok, text} =
        Session.send_e2e(subject, network.id, "alice", :msg, :text, {device.did, @alice}, payload(1600), nil)

      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, " #{text} 1/"), 10_000)
      [%{total: total} | _] = sent_fragments(server, text)
      assert total >= 6

      keyreq!(server, "alice", user, network)
      _ = await_keys(server, "alice", @alice)

      # The whole answer is out while the text still drips: it did not wait
      # behind the text in alice's queue.
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, " #{text} #{total}/#{total} "))
    end

    test "a KEYREQ the pacer cannot take spends no one-time key" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      upload_otks!(device, 1)

      # Fill alice's reactive lane, where the answer would go, with our
      # own NACKs: one line each.
      refused =
        Enum.find(1..(E2ePacer.max_lane_lines() + 10), fn _ ->
          Session.send_e2e(subject, network.id, "alice", :nack, :text, {device.did, @alice}, @small, nil) ==
            {:error, :rate_limited}
        end)

      assert refused, "alice's reactive lane never filled"

      keyreq!(server, "alice", user, network)

      assert E2eKeys.status(device).one_time_keys == 1
    end

    test "no second KEYS to a nick while the first is still going out, even once the nick may ask again" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [first] = listed(user, network)
      # Three devices, the most one identity holds (issue 2576): a KEYS of
      # about five lines, still dripping on the fake-lag bank when the
      # second KEYREQ comes (`waiting?` below).
      devices = [first | for(_ <- 1..2, do: add_listed_device!(subject, network))]
      Enum.each(devices, &upload_otks!(&1, 2))
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice", user, network)
      {:ok, _} = IRCServer.wait_for_line(server, &match?(%{verb: :keys}, fragment_to(&1, "alice")), @keys_timeout)
      assert E2ePacer.waiting?(:sys.get_state(pid).e2e_pacer, "alice", :keys)

      # Past the per-nick interval, as if 15 s had gone by: only the KEYS
      # still going out can hold the second answer back now.
      :sys.replace_state(pid, &%{&1 | e2e_key_answers: E2eKeyAnswers.new()})
      keyreq!(server, "alice", user, network)

      assert Enum.all?(devices, &(E2eKeys.status(&1).one_time_keys == 1))

      msgids =
        server
        |> IRCServer.sent_lines()
        |> Enum.map(&fragment_to(&1, "alice"))
        |> Enum.filter(&match?(%{verb: :keys}, &1))
        |> Enum.map(& &1.msgid)
        |> Enum.uniq()

      assert length(msgids) == 1
    end

    test "with no identity a KEYREQ goes unanswered and the session carries on" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice", user, network)

      assert Process.alive?(pid)
      assert E2eKeys.status(device) == %{one_time_keys: 0, fallback: false}
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E KEYS"))
    end
  end

  describe "a client's KEYREQ while the peer's KEYS is arriving" do
    test "is refused as rate-limited until the KEYS is whole: cicchetto never sees the fragments" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [first | rest] = lines_from("alice", :keys, "q83vEjRWeJA", {"*", device.did}, payload(900))
      assert rest != []

      IRCServer.feed(server, first)
      # A barrier: bob's message is handled after alice's first line.
      Enum.each(lines_from("bob", :msg, E2e.new_msgid(), {@bob, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout

      assert {:error, :rate_limited} =
               Session.send_e2e(subject, network.id, "Alice", :keyreq, :control, {device.did, "*"}, @small, nil)

      assert {:ok, _} = Session.send_e2e(subject, network.id, "bob", :keyreq, :control, {device.did, "*"}, @small, nil)

      Enum.each(rest, &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, verb: :keys}}, @wire_timeout

      assert {:ok, _} =
               Session.send_e2e(subject, network.id, "alice", :keyreq, :control, {device.did, "*"}, @small, nil)
    end
  end

  # issue 2577 — a client shows an encrypted message as arriving from its
  # first line until it lands (`e2e_message`) or the session says it will not
  # (`e2e_incoming_lost`). grappa reassembles and the client never sees a
  # line, so both facts can only come from here.
  describe "arriving" do
    test "a multi-line message is announced at its first line, once, then pushed whole" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [first | rest] = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, payload(900))
      assert rest != []

      IRCServer.feed(server, first)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming} = event}, @wire_timeout

      assert event == %{
               kind: :e2e_incoming,
               network: network.slug,
               from: "alice",
               from_did: @alice,
               to: device.did,
               msgid: "q83vEjRWeJA"
             }

      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}

      Enum.each(rest, &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "q83vEjRWeJA"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming}}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost}}
      assert Process.alive?(pid)
    end

    test "a one-line message and multi-line key material are never announced" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      keys = lines_from("alice", :keys, "AAAAAAAAAAA", {"*", device.did}, payload(900))
      assert length(keys) > 1

      Enum.each(lines_from("alice", :msg, "BBBBBBBBBBB", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      Enum.each(keys, &IRCServer.feed(server, &1))
      # bob's message is the barrier: once it is out, alice's lines are in.
      Enum.each(lines_from("bob", :msg, "CCCCCCCCCCC", {@bob, device.did}, @small), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
      assert_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "AAAAAAAAAAA"}}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming}}
    end

    test "a line that contradicts its message drops it, and the client is told it will not arrive" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [first | _] = short = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, payload(900))
      # The same msgid claiming another total.
      [_, other | _] = long = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, payload(2_000))
      assert length(long) != length(short)

      IRCServer.feed(server, first)
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming, msgid: "q83vEjRWeJA"}}, @wire_timeout
      IRCServer.feed(server, other)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost} = lost}, @wire_timeout

      assert lost == %{
               kind: :e2e_incoming_lost,
               network: network.slug,
               from_did: @alice,
               to: device.did,
               msgid: "q83vEjRWeJA"
             }

      assert Process.alive?(pid)
    end

    test "a message whose lines stop coming expires on the sweep, and the client is told" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [first | _] = lines_from("alice", :pkmsg, "q83vEjRWeJA", {@alice, "*"}, payload(900))

      IRCServer.feed(server, first)
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming, to: "*"}}, @wire_timeout
      age_reassembly!(pid)
      send(pid, :e2e_reassembly_sweep)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost} = lost}, @wire_timeout

      assert lost == %{
               kind: :e2e_incoming_lost,
               network: network.slug,
               from_did: @alice,
               to: "*",
               msgid: "q83vEjRWeJA"
             }
    end

    test "a message that expired is told of before the next line is handled, without waiting for the sweep" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [first | _] = lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, payload(900))

      IRCServer.feed(server, first)
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming, msgid: "q83vEjRWeJA"}}, @wire_timeout
      age_reassembly!(pid)
      Enum.each(lines_from("bob", :msg, "CCCCCCCCCCC", {@bob, device.did}, @small), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost, msgid: "q83vEjRWeJA"}},
                     @wire_timeout

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
    end

    # A whole message reaches the client only as an `e2e_message` for the
    # device whose queue took it. One that a device never gets would leave
    # that device showing it as arriving for good: the client keeps no
    # clock of its own.
    test "a whole message one device's queue refuses is lost to that device and pushed to the other" do
      {server, _, user, network} = connected_session()
      [full] = listed(user, network)
      other = add_listed_device!({:user, user.id}, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!(full, "alice", false)

      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, "*"}, payload(900)), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, to_did: to_did}}, @wire_timeout
      assert to_did == other.did
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost} = lost}, @wire_timeout

      assert lost == %{
               kind: :e2e_incoming_lost,
               network: network.slug,
               from_did: @alice,
               to: full.did,
               msgid: "q83vEjRWeJA"
             }

      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost}}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
    end

    test "a whole message no listed device can read is lost to the device it named" do
      {server, _, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(
        lines_from("alice", :msg, "q83vEjRWeJA", {@alice, "AAAAAAAAAAA"}, payload(900)),
        &IRCServer.feed(server, &1)
      )

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming, to: "AAAAAAAAAAA"}}, @wire_timeout
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost} = lost}, @wire_timeout

      assert lost == %{
               kind: :e2e_incoming_lost,
               network: network.slug,
               from_did: @alice,
               to: "AAAAAAAAAAA",
               msgid: "q83vEjRWeJA"
             }

      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
    end

    # The one rule (`e2e_arriving?/1`) holds for a loss as for an
    # announcement: a one-line message was never announced, so no device is
    # told it will not arrive, even when none can read it.
    test "a one-line message no listed device can read is NACKed and never told lost" do
      {server, _, user, _} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      msgid = E2e.new_msgid()
      [line] = lines_from("alice", :msg, msgid, {@alice, "AAAAAAAAAAA"}, @small)

      IRCServer.feed(server, line)

      # The NACK proves the line reached the no-device branch; a loss, had
      # there been one, was broadcast before it (same callback, earlier).
      assert {:ok, _} = IRCServer.wait_for_line(server, &nack_of?(&1, "alice", msgid), @nack_timeout)
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming_lost}}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_incoming}}
    end
  end

  describe "offline queue" do
    test "a message the queue refuses is not pushed, and the recipient is told on the next sweep, naming the device" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!(device, "alice", false)

      Enum.each(lines_from("alice", :msg, "q83vEjRWeJA", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      Enum.each(lines_from("alice", :msg, "BBBBBBBBBBB", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      # bob's message is the barrier: once it is out, alice's lines are in.
      Enum.each(lines_from("bob", :msg, "CCCCCCCCCCC", {@bob, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}

      sweep(pid)

      assert [notice] = notices(network)

      assert {notice.channel, notice.sender, notice.meta} ==
               {"alice", "alice", %{e2e_undeliverable: 2, e2e_device: device.did}}

      # Told once: the count went out with the notice.
      sweep(pid)
      assert length(notices(network)) == 1
    end

    test "refused key material and NACKs are not counted: there was no message to tell about" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!(device, "alice", false)

      Enum.each(lines_from("alice", :keys, "AAAAAAAAAAA", {"*", device.did}, @small), &IRCServer.feed(server, &1))
      Enum.each(lines_from("alice", :nack, "BBBBBBBBBBB", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      Enum.each(lines_from("bob", :msg, "CCCCCCCCCCC", {@bob, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}

      sweep(pid)

      assert notices(network) == []
    end

    test "the sweep drops what expired and leaves one notice per sender and device, in that sender's query window" do
      {_, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      other = add_listed_device!(subject, network)
      old = Enum.map(["Alice", "alice", "bob"], &put_entry!(device, &1, :msg))
      elsewhere = put_entry!(other, "alice", :msg)
      keys = put_entry!(device, "carol", :keys)
      fresh = put_entry!(device, "alice", :msg)
      Enum.each([keys, elsewhere | old], &age!(&1, E2eInbox.ttl_seconds() + 60))

      sweep(pid)

      assert [%E2eInbox.Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == fresh.id
      assert E2eInbox.list(other, 0) == []

      # Not scrollback content: no body, no DM thread — a typed row the
      # client renders, filed under the peer's query window, naming the
      # device that never read it.
      rows = network |> notices() |> Enum.map(&{&1.channel, &1.sender, &1.dm_with, &1.body, &1.meta}) |> Enum.sort()

      assert rows ==
               Enum.sort([
                 {"alice", "alice", nil, nil, %{e2e_undeliverable: 2, e2e_device: device.did}},
                 {"alice", "alice", nil, nil, %{e2e_undeliverable: 1, e2e_device: other.did}},
                 {"bob", "bob", nil, nil, %{e2e_undeliverable: 1, e2e_device: device.did}}
               ])

      assert QueryWindows.open?(subject, network.id, "alice")
      assert QueryWindows.open?(subject, network.id, "bob")
      refute QueryWindows.open?(subject, network.id, "carol")
    end

    test "a queued PKMSG or MSG pushes one notification however many devices got it; key material and NACKs none" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      _ = add_listed_device!({:user, user.id}, network)
      bypass = Bypass.open()
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      stored_subscription!({:user, user.id}, %{
        endpoint: "http://localhost:#{bypass.port}/wp",
        p256dh_key: @client_p256dh,
        auth_key: @client_auth,
        user_agent: "Mozilla/5.0 e2e-session-test"
      })

      test_pid = self()
      handler = "e2e-push-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler,
        [:grappa, :push, :send, :stop],
        fn _, _, meta, _ -> send(test_pid, {:pushed, meta}) end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler) end)

      Enum.each(lines_from("alice", :keys, "AAAAAAAAAAA", {"*", device.did}, @small), &IRCServer.feed(server, &1))
      Enum.each(lines_from("alice", :nack, "BBBBBBBBBBB", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      refute_receive {:pushed, _}, 500

      Enum.each(lines_from("alice", :msg, "CCCCCCCCCCC", {@alice, "*"}, @small), &IRCServer.feed(server, &1))
      assert_receive {:pushed, %{subject: {:user, _}}}, 2_000
      refute_receive {:pushed, _}, 500
    end

    test "a session sweeps what expired while it was down as soon as it starts" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
      {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
      _ = credential_fixture(user, network, %{})
      subject = {:user, user.id}
      [device] = identity!(subject, network, 1)
      entry = put_entry!(device, "alice", :pkmsg)
      age!(entry, E2eInbox.ttl_seconds() + 60)

      pid = start_session!(user, network)
      :ok = IRCServer.await_handshake(server, @wire_timeout)
      _ = :sys.get_state(pid)

      assert [%Message{channel: "alice", meta: %{e2e_undeliverable: 1}}] = notices(network)
      assert E2eInbox.list(device, 0) == []
    end
  end

  describe "outbound" do
    # Channel E2E (protocol v63): one `:msg` to `*` goes out as one line
    # to the channel — IRC multicast does the fan-out, so the message
    # costs one line, not one per member.
    test "a channel :msg to a channel we joined goes out as one line to the channel" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      assert {:ok, msgid} =
               Session.send_e2e(
                 {:user, user.id},
                 network.id,
                 "#grappa",
                 :msg,
                 :text,
                 {device.did, "*"},
                 @group_small,
                 nil
               )

      assert E2e.msgid?(msgid)
      {:ok, line} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 10_000)
      assert String.starts_with?(line, "PRIVMSG #grappa :")
      ["PRIVMSG #grappa", body] = line |> String.trim_trailing("\r\n") |> String.split(" :", parts: 2)
      assert {:ok, %{verb: :msg, from: from, to: "*"}} = E2e.parse(body)
      assert from == device.did
      assert text_rows(network) == 0
    end

    test "a channel message to a channel we never joined, with the wrong verb, or to a device is refused" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      subject = {:user, user.id}

      IRCServer.feed(server, ":#{@nick}!u@h JOIN #grappa\r\n")
      :ok = await_joined(pid, "#grappa")

      # Not a member: the facade passes the shape, the session refuses.
      assert {:error, :bad_request} =
               Session.send_e2e(subject, network.id, "#italia", :msg, :text, {device.did, "*"}, @group_small, nil)

      # Only `:msg` goes to a channel: a PKMSG opens a pairwise session,
      # a KEYREQ answers one.
      assert {:error, :bad_request} =
               Session.send_e2e(subject, network.id, "#grappa", :pkmsg, :text, {device.did, "*"}, @group_small, nil)

      assert {:error, :bad_request} =
               Session.send_e2e(subject, network.id, "#grappa", :keyreq, :control, {device.did, "*"}, @small, nil)

      # A channel frame has no single recipient device.
      assert {:error, :bad_request} =
               Session.send_e2e(subject, network.id, "#grappa", :msg, :text, {device.did, @alice}, @group_small, nil)

      assert Process.alive?(pid)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "PRIVMSG #"))
    end

    # The pacer's lanes are keyed on the folded nick (the session folds),
    # and nothing else pins that: two spellings of one peer must share one
    # queue, or each spelling gets its own FLUD window and its own bound.
    # The per-peer text bound is what tells one lane from two here.
    test "two spellings of one nick share one queue: its bound refuses both" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      send = &Session.send_e2e(subject, network.id, &1, :msg, :text, {device.did, @alice}, @small, nil)

      refused = Enum.find(1..(E2ePacer.max_text_messages() + 10), fn _ -> send.("Bob") == {:error, :rate_limited} end)

      assert refused, "Bob's queue never filled"
      assert {:error, :rate_limited} = send.("bob")
      assert {:ok, _} = send.("carol")
    end

    test "a message goes out as lines that fit the relay, name both devices, reassemble, wait on the fake-lag bank, and are never stored" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      payload = payload(800)

      assert {:ok, msgid} =
               Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, {device.did, "*"}, payload, nil)

      assert E2e.msgid?(msgid)

      # A full line costs 5 s of bahamut fake lag, and the lines wait on the
      # CONNECTION's bank, read from the client. Whatever the bank held at
      # the start, line 2 leaves it at the 10 s ceiling, so line 3 (full, in
      # a 4+ line message) leaves at least 5 s after line 2. The
      # per-recipient FLUD rule alone would have sent three lines at once.
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} 1/"), 10_000)
      [%{total: total}] = sent_fragments(server, msgid)
      assert total >= 4
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} 2/"), 10_000)
      second_at = System.monotonic_time(:millisecond)
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} 3/"), 10_000)
      gap = System.monotonic_time(:millisecond) - second_at
      assert gap >= 4_500, "line 3 left #{gap} ms after line 2"
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} #{total}/"), 5_500 * total)

      fragments = sent_fragments(server, msgid)
      assert Enum.all?(fragments, &(&1.verb == :msg and &1.from == device.did and &1.to == "*"))
      assert fragments |> Enum.sort_by(& &1.index) |> Enum.map_join(& &1.chunk) == payload

      # The ircd relays `:<nick>!<user>@<host> PRIVMSG alice :<body>\r\n`; the
      # budget reserved the worst-case prefix, so the client's own line is
      # shorter than 512 by at least that reserve.
      reserve = LineSplit.relay_frame_overhead("alice") - byte_size("PRIVMSG alice :\r\n")
      lines = server |> IRCServer.sent_lines() |> Enum.filter(&String.contains?(&1, msgid))
      assert Enum.all?(lines, &(byte_size(&1) <= 512 - reserve))

      assert rows(network) == 0
    end

    # issue 2497 — the encrypted window lives in cicchetto only, so no query
    # window is open for the nick and the 401 is filed under $server (#640).
    # What reaches the window is the typed fact that the nick is not there.
    test "a line to a nick that is not on the network: its 401 lands on $server and the user topic says the nick is absent" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.channel(user.name, network.slug, "$server"))

      assert {:ok, msgid} =
               Session.send_e2e(
                 {:user, user.id},
                 network.id,
                 "Ghost",
                 :keyreq,
                 :control,
                 {device.did, "*"},
                 @small,
                 nil
               )

      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 10_000)
      IRCServer.feed(server, ":irc 401 #{@nick} Ghost :No such nick/channel\r\n")

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :no_such_nick, network: slug, nick: "Ghost"}},
                     @wire_timeout

      assert slug == network.slug

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{message: %{channel: "$server", body: "No such nick/channel"}}
                     },
                     @wire_timeout

      refute QueryWindows.open?({:user, user.id}, network.id, "ghost")
    end

    test "a client that cannot answer holds the line instead of killing the session" do
      # The bank read is a call into the client, and the client stops
      # answering while it connects (up to 30 s per address) or sits on a
      # stuck write. Issue 2370's lesson: that must never take the session
      # down. Here the session queues the line and asks again later.
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      # Registration's own last write (the umode query) must be done first,
      # or the session is still inside THAT call when the client freezes.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)
      client = :sys.get_state(pid).client
      :ok = :sys.suspend(client)

      assert {:ok, msgid} =
               Session.send_e2e(
                 {:user, user.id},
                 network.id,
                 "alice",
                 :keyreq,
                 :control,
                 {device.did, "*"},
                 @small,
                 nil
               )

      assert Process.alive?(pid)

      :ok = :sys.resume(client)
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 10_000)
    end

    test "an order's answer that can no longer make its deadline is dropped unsent, the sender told, and the next line goes" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      send = &Session.send_e2e(subject, network.id, "alice", &1, :control, &2, @small, &3)

      # Three KEYREQs fill alice's window for 6 s.
      for _ <- 1..3, do: {:ok, _} = send.(:keyreq, {device.did, "*"}, nil)

      # An ACK whose CHAL expires in 5 s: accepted, since it might still
      # start in time, but the window opens too late for it to be back
      # by then. The KEYREQ behind it goes when the window opens.
      expires_at = System.os_time(:second) + 5
      assert {:ok, ack} = send.(:msg, {device.did, @alice}, expires_at)
      {:ok, keyreq} = send.(:keyreq, {device.did, "*"}, nil)

      assert {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, keyreq), 10_000)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, ack))

      slug = network.slug

      assert_received %Phoenix.Socket.Broadcast{
        payload: %{kind: :e2e_send_dropped, network: ^slug, target: "alice", msgid: ^ack, reason: :late}
      }
    end

    # issue 2575: the bot's CHAL now lives 15 s plus its own wire time at
    # an empty bank, 29 s for a CHAL to 4 devices. grappa takes the
    # deadline from the CHAL and holds no ceiling of its own.
    test "an order's answer to a CHAL that lives past 15 s is taken, and goes when the window opens" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      send = &Session.send_e2e(subject, network.id, "alice", &1, :control, &2, @small, &3)

      for _ <- 1..3, do: {:ok, _} = send.(:keyreq, {device.did, "*"}, nil)

      expires_at = System.os_time(:second) + 29
      assert {:ok, ack} = send.(:msg, {device.did, @alice}, expires_at)

      assert {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, ack), 10_000)
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_send_dropped, msgid: ^ack}}
    end

    test "an order's answer already too late to make its deadline is refused at the door" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      # Under the 2 s the answer needs to come back.
      expires_at = System.os_time(:second) + 1

      assert {:error, :too_late} =
               Session.send_e2e(
                 {:user, user.id},
                 network.id,
                 "alice",
                 :msg,
                 :control,
                 {device.did, @alice},
                 @small,
                 expires_at
               )

      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
    end

    test "a line that fails to go out drops the rest of its message, from this batch and the queue; the sender is told, the rest goes on" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      # Registration's own last write must be done before the client is swapped.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)

      # Two lines that fit an empty bank together, so they leave in one batch.
      body = payload(250)
      addresses = {device.did, @alice}
      {:ok, bodies} = E2e.fragment(:msg, E2e.new_msgid(), addresses, body, LineSplit.frame_budget("Alice", 512))
      assert [_, _] = costs = Enum.map(bodies, &Client.privmsg_cost_ms("Alice", &1))
      assert Enum.sum(costs) <= Client.fake_lag_ceiling_ms()

      # From here a write to "Alice", spelt so, fails; any other goes out.
      stub = failing_client(pid, "Alice")
      :sys.replace_state(pid, &%{&1 | client: stub})

      {:ok, ack} = Session.send_e2e(subject, network.id, "Alice", :msg, :control, addresses, body, nil)

      # The first line fails, and the second is never attempted.
      assert_received {:failed, "PRIVMSG Alice :" <> first}
      assert first =~ " #{ack} 1/2 "
      refute_received {:failed, _}
      refute_received {:wrote, "PRIVMSG Alice " <> _}
      assert queued_lines(pid, ack) == 0

      assert_received %Phoenix.Socket.Broadcast{
        payload: %{kind: :e2e_send_dropped, target: "Alice", msgid: ^ack, reason: :send_failed}
      }

      # The urgent lane the message held is free: the next order goes.
      {:ok, keyreq} = Session.send_e2e(subject, network.id, "bob", :keyreq, :control, {device.did, "*"}, @small, nil)
      assert_received {:wrote, "PRIVMSG bob :" <> line}
      assert line =~ keyreq
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_send_dropped}}
    end

    test "what still waits when the session ends is dropped, and the sender told" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      # A long text message: one line leaves, the rest wait on the bank.
      {:ok, msgid} =
        Session.send_e2e(subject, network.id, "alice", :msg, :text, {device.did, @alice}, payload(1600), nil)

      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, " #{msgid} 1/"), 10_000)

      :ok = Session.stop_session(subject, network.id)

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_send_dropped, target: "alice", msgid: ^msgid, reason: :session_ended}
                     },
                     @wire_timeout
    end

    test "a reactive MSG goes ahead of the text already waiting for that peer" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      send = &Session.send_e2e(subject, network.id, "alice", :msg, &1, {device.did, @alice}, &2, nil)

      {:ok, text} = send.(:text, payload(1600))
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, " #{text} 1/"), 10_000)
      [%{total: total} | _] = sent_fragments(server, text)

      # A device list a peer asked for (`t:list`): grappa cannot see inside
      # it, so the client says it answers the peer's protocol state.
      {:ok, list} = send.(:reactive, @small)
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, list), 15_000)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, " #{text} #{total}/#{total} "))
    end

    test "refuses what is not a nick, a verb a client may not send, an unknown priority, addresses the verb may not carry, and a payload that is not JSON text" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      mine = device.did
      send = &Session.send_e2e(subject, network.id, &1, &2, &3, &4, &5, &6)

      assert {:error, :bad_request} = send.("#italia", :msg, :text, {mine, @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :keys, :text, {"*", @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :offline, :text, {mine, @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :msg, :urgent, {mine, @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :msg, :text, {mine, @alice}, ~s({"v": 2}), nil)
      assert {:error, :bad_request} = send.("alice", :msg, :text, {mine, @alice}, "café", nil)
      assert {:error, :bad_request} = send.("alice", :msg, :text, {mine, @alice}, "", nil)
      assert {:error, :invalid_line} = send.("alice\r\nQUIT", :msg, :text, {mine, @alice}, @small, nil)

      # The frame's addressing table, at the door.
      assert {:error, :bad_request} = send.("alice", :keyreq, :control, {mine, @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :nack, :text, {mine, "*"}, @small, nil)
      # `*` speaks for the user, and only grappa does: a client sends from a
      # device, so this is refused at the door, not as an unknown device.
      assert {:error, :bad_request} = send.("alice", :nack, :text, {"*", @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :msg, :text, {"*", @alice}, @small, nil)
      assert {:error, :bad_request} = send.("alice", :msg, :text, {"short", @alice}, @small, nil)

      # A deadline belongs to an order's CHAL or ACK only: a MSG/PKMSG marked
      # control.
      soon = System.os_time(:second) + 15
      assert {:error, :bad_request} = send.("alice", :msg, :text, {mine, @alice}, @small, soon)
      assert {:error, :bad_request} = send.("alice", :keyreq, :control, {mine, "*"}, @small, soon)
      assert {:error, :bad_request} = send.("alice", :nack, :control, {mine, @alice}, @small, soon)
      assert {:error, :bad_request} = send.("alice", :msg, :control, {mine, @alice}, @small, 0)
      assert {:ok, _} = send.("alice", :pkmsg, :control, {mine, @alice}, @small, soon)
    end

    test "a device speaks only once listed: one still being paired, or one nobody registered, is refused" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      %{device: pairing} = register_device!(subject, network)
      someone_elses = add_listed_device!({:user, user_fixture().id}, network)

      for from <- [pairing.did, someone_elses.did, "AAAAAAAAAAA"] do
        assert {:error, :unknown_device} =
                 Session.send_e2e(subject, network.id, "alice", :keyreq, :control, {from, "*"}, @small, nil)
      end

      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
    end

    test "a payload that needs more than 64 lines is refused before anything is sent" do
      {server, _, user, network} = connected_session()
      [device] = listed(user, network)
      # Under the 32 KiB door bound, so it is the session's cut that refuses.
      huge = payload(20_000)
      assert byte_size(huge) < E2e.max_payload_bytes()

      assert {:error, :too_large} =
               Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, {device.did, @alice}, huge, nil)

      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
    end

    test "with no session the send is refused, not swallowed" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      network = network_fixture()
      [device] = identity!({:user, user.id}, network, 1)

      assert {:error, :no_session} =
               Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, {device.did, @alice}, @small, nil)
    end
  end

  # S1: a device copies what it sent to the subject's other listed devices
  # (its siblings), through their queues and never through IRC.
  describe "copies to the subject's other devices" do
    test "copy_e2e queues an own copy in the sibling's inbox and pushes e2e_message with own: true" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      sibling = add_listed_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      payload = payload(900)

      assert {:ok, %E2eInbox.Entry{id: id, msgid: msgid}} =
               Session.copy_e2e(subject, network.id, device.did, sibling.did, :pkmsg, payload)

      # The session picked the msgid, as it does for a message to a peer.
      assert E2e.msgid?(msgid)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message} = event}, @wire_timeout

      # Our own nick is the sender: the copy is ours, flagged as such.
      assert event == %{
               kind: :e2e_message,
               id: id,
               network: network.slug,
               from: @nick,
               from_did: device.did,
               to_did: sibling.did,
               verb: :pkmsg,
               msgid: msgid,
               payload: payload,
               own: true,
               channel: nil
             }

      assert [%E2eInbox.Entry{id: ^id, own: true, sender: @nick, payload: ^payload}] = E2eInbox.list(sibling, 0)
      assert E2eInbox.list(device, 0) == []

      # Never on IRC, never stored.
      _ = :sys.get_state(pid)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
      assert rows(network) == 0
    end

    test "copy_e2e sends no OS push" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      sibling = add_listed_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      bypass = Bypass.open()
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      stored_subscription!(subject, %{
        endpoint: "http://localhost:#{bypass.port}/wp",
        p256dh_key: @client_p256dh,
        auth_key: @client_auth,
        user_agent: "Mozilla/5.0 e2e-session-test"
      })

      test_pid = self()
      handler = "e2e-copy-push-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler,
        [:grappa, :push, :send, :stop],
        fn _, _, meta, _ -> send(test_pid, {:pushed, meta}) end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler) end)

      for verb <- [:pkmsg, :msg] do
        assert {:ok, _} = Session.copy_e2e(subject, network.id, device.did, sibling.did, verb, @small)
      end

      refute_receive {:pushed, _}, 500

      # The same subscription does push for a peer's message: the silence
      # above is the copy's, not the harness's.
      Enum.each(lines_from("alice", :msg, "CCCCCCCCCCC", {@alice, device.did}, @small), &IRCServer.feed(server, &1))
      assert_receive {:pushed, %{subject: {:user, _}}}, 2_000
    end

    test "copy_e2e refuses an unlisted target, the sender's own did, and a non-message verb" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      sibling = add_listed_device!(subject, network)
      %{device: pairing} = register_device!(subject, network)
      someone_elses = add_listed_device!({:user, user_fixture().id}, network)
      copy = &Session.copy_e2e(subject, network.id, &1, &2, &3, &4)

      # Both ends are devices the subject's list names, and they differ.
      for to <- [pairing.did, someone_elses.did, "AAAAAAAAAAA"] do
        assert {:error, :not_found} = copy.(device.did, to, :msg, @small)
      end

      for from <- [pairing.did, someone_elses.did, "AAAAAAAAAAA"] do
        assert {:error, :unknown_device} = copy.(from, sibling.did, :msg, @small)
      end

      assert {:error, :same_device} = copy.(device.did, device.did, :msg, @small)

      # Only what a person wrote is copied, as compact JSON text the
      # receiver can hold.
      for verb <- [:keyreq, :keys, :nack, :offline] do
        assert {:error, :bad_request} = copy.(device.did, sibling.did, verb, @small)
      end

      for bad <- ["", "café", ~s({"v": 2})] do
        assert {:error, :bad_request} = copy.(device.did, sibling.did, :msg, bad)
      end

      huge = String.duplicate("A", E2e.max_payload_bytes() + 1)
      assert {:error, :too_large} = copy.(device.did, sibling.did, :msg, huge)

      for d <- [device, sibling, pairing, someone_elses], do: assert(E2eInbox.list(d, 0) == [])
    end

    test "a copy is queued while the session has no IRC Client (the reconnect backoff window)" do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}

      {network, _} =
        network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

      _ = credential_fixture(user, network, %{})
      [device, sibling] = identity!(subject, network, 2)

      # Ladder at the cap: the Client spawn is deferred, so the session lives
      # with `client: nil`, as between two reconnect attempts.
      :ok = Backoff.reset(subject, network.id)
      Enum.each(1..10, fn _ -> :ok = Backoff.record_failure(subject, network.id) end)
      on_exit(fn -> Backoff.reset(subject, network.id) end)
      pid = start_session!(user, network)

      # The precondition: whatever needs the socket is refused right now.
      assert {:error, :no_socket} = Session.send_privmsg(subject, network.id, "#test", "lost")

      # A copy never goes on IRC, so it does not wait for the link.
      assert {:ok, %E2eInbox.Entry{id: id}} =
               Session.copy_e2e(subject, network.id, device.did, sibling.did, :msg, @small)

      assert [%E2eInbox.Entry{id: ^id, own: true}] = E2eInbox.list(sibling, 0)
      assert Process.alive?(pid)
    end

    test "with no session a copy is refused, not swallowed" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      network = network_fixture()
      [device, sibling] = identity!({:user, user.id}, network, 2)

      assert {:error, :no_session} =
               Session.copy_e2e({:user, user.id}, network.id, device.did, sibling.did, :msg, @small)

      assert E2eInbox.list(sibling, 0) == []
    end

    test "a copy the sibling's queue refuses is refused to the caller, not pushed, and never told" do
      {_, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      sibling = add_listed_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!(sibling, @nick, true)

      assert {:error, :inbox_full} = Session.copy_e2e(subject, network.id, device.did, sibling.did, :msg, @small)
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}, 100

      # A refused copy is simply missing on that device: no notice, now or
      # at any later sweep.
      sweep(pid)
      assert notices(network) == []
    end

    test "an own copy that expires writes no undeliverable row" do
      {_, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      sibling = add_listed_device!(subject, network)

      {:ok, copy} = Session.copy_e2e(subject, network.id, device.did, sibling.did, :msg, @small)
      peer = put_entry!(sibling, "alice", :msg)
      Enum.each([copy, peer], &age!(&1, E2eInbox.ttl_seconds() + 60))

      sweep(pid)

      # Both went; only the peer's is told, so the sweep did run.
      assert E2eInbox.list(sibling, 0) == []

      assert [%Message{channel: "alice", meta: %{e2e_undeliverable: 1, e2e_device: did}}] = notices(network)
      assert did == sibling.did
    end
  end

  describe "encrypted-chat requests (issue 2486)" do
    # grappa's own lines wait on the connection's fake-lag bank, which the
    # registration has just filled.
    @consent_timeout 15_000

    # The master-key hint the proposal puts in every consent payload.
    @hint ~s({"v":2,"master":"m4st3rK3yHintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})

    test "a stranger's REQUEST is kept, opens the plaintext query, pushes once, and is never queued or stored; again, it only refreshes" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      push_telemetry!(user)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      refute QueryWindows.open?(subject, network.id, "alice")

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, network: slug, request: request}},
                     @wire_timeout

      assert slug == network.slug
      assert %{peer: "alice", state: :incoming, payload: @hint, expires_at: deadline} = request
      assert is_binary(deadline)
      assert QueryWindows.open?(subject, network.id, "alice")
      assert_receive {:pushed, %{subject: ^subject}}, 2_000

      Enum.each(consent_from("ALICE", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: id, state: :incoming}}},
                     @wire_timeout

      assert id == request.id
      refute_receive {:pushed, _}, 500

      assert E2eInbox.list(device, 0) == []
      assert rows(network) == 0
      assert Process.alive?(pid)
    end

    test "a line nobody asked for, or a payload outside the rule, changes nothing and the session carries on" do
      {server, pid, user, network} = connected_session()
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for verb <- [:accept, :refuse, :cancel],
          do: Enum.each(consent_from("bob", verb, @hint), &IRCServer.feed(server, &1))

      big = ~s({"v":2,"pad":"#{String.duplicate("A", Request.max_payload_bytes())}"})
      Enum.each(consent_from("carol", :request, big), &IRCServer.feed(server, &1))

      # A good line last: once ITS event arrives, every line before it has
      # been through the session.
      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{peer: "alice"}}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request}}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone}}

      assert [%Request{peer: "alice"}] = E2eRequests.list({:user, user.id}, network.id, DateTime.utc_now())
      assert E2eInbox.list(device, 0) == []
      assert Process.alive?(pid)
    end

    test "asking sends REQUEST from the device to the user and holds it outgoing; the peer's ACCEPT, then a REFUSE elsewhere, reach every device" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, %Request{id: id, state: :outgoing, peer: "Alice"}} =
               Session.ask_e2e(subject, network.id, "Alice", device.did, @hint)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: ^id, state: :outgoing}}},
                     @wire_timeout

      assert %{verb: :request, from: from, to: "*", chunk: @hint} = await_consent(server, "Alice", :request)
      assert from == device.did
      # Asking opens no window: the user asked from the one they were in.
      refute QueryWindows.open?(subject, network.id, "alice")

      Enum.each(consent_from("alice", :accept, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_request, request: %{id: ^id, state: :accepted, expires_at: nil}}
                     },
                     @wire_timeout

      {:ok, %Request{id: bob}} = Session.ask_e2e(subject, network.id, "bob", device.did, @hint)
      _ = await_consent(server, "bob", :request)
      Enum.each(consent_from("bob", :refuse, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: ^bob, state: :refused}}},
                     @wire_timeout

      # The refusal is shown in the plaintext query, which the requester may
      # have closed during a long wait.
      assert QueryWindows.open?(subject, network.id, "bob")
    end

    test "accepting the waiting request sends ACCEPT and the row goes on every device; refusing sends REFUSE" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      for nick <- ["alice", "bob"], do: Enum.each(consent_from(nick, :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{peer: "alice", id: alice}}},
                     @wire_timeout

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{peer: "bob", id: bob}}},
                     @wire_timeout

      assert {:ok, msgid} = Session.answer_e2e(subject, network.id, alice, :accept, {device.did, @hint})
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^alice}}, @wire_timeout
      assert %{verb: :accept, msgid: ^msgid, to: "*"} = await_consent(server, "alice", :accept)

      assert {:ok, _} = Session.answer_e2e(subject, network.id, bob, :refuse, {device.did, @hint})
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^bob}}, @wire_timeout
      assert %{verb: :refuse} = await_consent(server, "bob", :refuse)

      assert E2eRequests.list(subject, network.id, DateTime.utc_now()) == []
      assert {:error, :not_found} = Session.answer_e2e(subject, network.id, alice, :accept, {device.did, @hint})
    end

    test "refusing with no line says no for the user: REFUSE goes from `*` to the device of their latest REQUEST" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      # At an empty bank a line let go is written before the call returns.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)
      stub = failing_client(pid, "nobody")
      :sys.replace_state(pid, &%{&1 | client: stub})

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: id}}}, @wire_timeout
      # They asked again from another device: that one is told.
      Enum.each(lines_from("alice", :request, E2e.new_msgid(), {@bob, "*"}, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: ^id}}}, @wire_timeout

      assert {:error, :bad_request} = Session.answer_e2e(subject, network.id, id, :accept, nil)
      assert {:ok, msgid} = Session.answer_e2e(subject, network.id, id, :refuse, nil)
      assert_received {:wrote, line}
      assert %{verb: :refuse, msgid: ^msgid, from: "*", to: @bob, chunk: ~s({"v":2})} = fragment_to(line, "alice")
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^id}}, @wire_timeout
    end

    test "asking a peer whose request is waiting answers it: ACCEPT goes and the row reads accepted" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: id}}}, @wire_timeout

      assert {:ok, %Request{id: ^id, state: :accepted}} =
               Session.ask_e2e(subject, network.id, "alice", device.did, @hint)

      assert %{verb: :accept} = await_consent(server, "alice", :accept)
    end

    test "a peer's REQUEST that meets our consent is answered ACCEPT from the user to the device that asked; an ACCEPT, or an expired asking, is not answered" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      # At an empty bank a line let go is written before the call returns.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)
      stub = failing_client(pid, "nobody")
      :sys.replace_state(pid, &%{&1 | client: stub})

      # Our live asking: their REQUEST is their consent, and they hear ours
      # even if our REQUEST never reached them.
      {:ok, %Request{id: alice}} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      assert_received {:wrote, "PRIVMSG alice :\x01E2E REQUEST " <> _}
      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_request, request: %{id: ^alice, state: :accepted}}
                     },
                     @wire_timeout

      assert_receive {:wrote, line}, @wire_timeout
      assert %{verb: :accept, from: "*", to: @alice, chunk: ~s({"v":2})} = fragment_to(line, "alice")

      # Already accepted: the row stays, and the ACCEPT goes again.
      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive {:wrote, line}, @wire_timeout
      assert %{verb: :accept, from: "*", to: @alice} = fragment_to(line, "alice")
      assert %Request{id: ^alice, state: :accepted} = E2eRequests.for_peer(subject, network.id, "alice")

      # An ACCEPT moves our asking and draws nothing back.
      {:ok, %Request{id: bob}} = Session.ask_e2e(subject, network.id, "bob", device.did, @hint)
      assert_received {:wrote, "PRIVMSG bob :\x01E2E REQUEST " <> _}
      Enum.each(consent_from("bob", :accept, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: ^bob, state: :accepted}}},
                     @wire_timeout

      _ = :sys.get_state(pid)
      refute_received {:wrote, _}

      # An expired asking is no consent: a fresh incoming request, unanswered.
      {:ok, %Request{id: carol}} = Session.ask_e2e(subject, network.id, "carol", device.did, @hint)
      assert_received {:wrote, "PRIVMSG carol :\x01E2E REQUEST " <> _}
      age_request!(carol, E2eRequests.ttl_seconds() + 60)
      Enum.each(consent_from("carol", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_request, request: %{id: ^carol, state: :incoming}}
                     },
                     @wire_timeout

      _ = :sys.get_state(pid)
      refute_received {:wrote, _}
    end

    test "an ACCEPT the pacer cannot take is let go: the row still moves and the session carries on" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      {:ok, %Request{id: alice}} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)

      send = fn ->
        Session.send_e2e(subject, network.id, "alice", :msg, :reactive, {device.did, @alice}, @small, nil)
      end

      assert Enum.find(1..(E2ePacer.max_lane_lines() + 10), fn _ -> send.() == {:error, :rate_limited} end),
             "alice's reactive lane never filled"

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :e2e_request, request: %{id: ^alice, state: :accepted}}
                     },
                     @wire_timeout

      refute E2ePacer.waiting?(:sys.get_state(pid).e2e_pacer, "alice", :accept)
      assert Process.alive?(pid)
    end

    test "dismissing cancels our live request on the wire; an answer just goes; a waiting request is answered, not dismissed" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      {:ok, %Request{id: alice}} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      assert {:error, :bad_request} = Session.dismiss_e2e(subject, network.id, alice, nil)
      assert :ok = Session.dismiss_e2e(subject, network.id, alice, {device.did, @hint})
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^alice}}, @wire_timeout
      assert %{verb: :cancel, to: "*"} = await_consent(server, "alice", :cancel)

      {:ok, %Request{id: bob}} = Session.ask_e2e(subject, network.id, "bob", device.did, @hint)
      _ = await_consent(server, "bob", :request)
      Enum.each(consent_from("bob", :accept, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: ^bob, state: :accepted}}},
                     @wire_timeout

      assert :ok = Session.dismiss_e2e(subject, network.id, bob, nil)
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^bob}}, @wire_timeout
      refute Enum.any?(IRCServer.sent_lines(server), &match?(%{verb: :cancel}, fragment_to(&1, "bob")))

      Enum.each(consent_from("carol", :request, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{peer: "carol", id: carol}}},
                     @wire_timeout

      assert {:error, :request_state} = Session.dismiss_e2e(subject, network.id, carol, {device.did, @hint})
    end

    test "a line the pacer cannot take leaves no row behind" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)

      send = fn ->
        Session.send_e2e(subject, network.id, "alice", :msg, :reactive, {device.did, @alice}, @small, nil)
      end

      assert Enum.find(1..(E2ePacer.max_lane_lines() + 10), fn _ -> send.() == {:error, :rate_limited} end),
             "alice's reactive lane never filled"

      assert {:error, :rate_limited} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      assert E2eRequests.for_peer(subject, network.id, "alice") == nil
    end

    test "a LINELEN too short to frame a consent line refuses it as too large, writes no row, and the session carries on" do
      {_, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)

      # A network may advertise any positive LINELEN; this one frames no byte.
      :sys.replace_state(pid, &%{&1 | isupport: %{&1.isupport | linelen: 16}})

      assert {:error, :too_large} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      assert E2eRequests.for_peer(subject, network.id, "alice") == nil
      assert Process.alive?(pid)
    end

    test "an ask past the requests we started is refused, and its REQUEST is not written, even at an empty bank" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      now = DateTime.utc_now()

      for n <- 1..E2eRequests.max_rows() do
        {:request, plan} = E2eRequests.ask(nil, "peer#{n}", now)
        {:ok, _} = E2eRequests.commit(subject, network.id, plan, now)
      end

      # Registration's own last write must be done before the client is
      # swapped. At an empty bank a line let go is written before the call
      # returns.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)
      stub = failing_client(pid, "nobody")
      :sys.replace_state(pid, &%{&1 | client: stub})

      assert {:error, :requests_full} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      refute_received {:wrote, _}
      assert E2eRequests.for_peer(subject, network.id, "alice") == nil

      # Asking a peer already asked takes no new room, and its line is written at once.
      assert {:ok, %Request{state: :outgoing}} = Session.ask_e2e(subject, network.id, "peer1", device.did, @hint)
      assert_received {:wrote, "PRIVMSG peer1 :\x01E2E REQUEST " <> _}
    end

    # issue 2599 — the peer's nick is the upstream's call (IRCnet's `foo~`).
    test "a nick the upstream allows is an address the send and request doors take" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)

      assert {:ok, %Request{state: :outgoing, peer: "foo~"}} =
               Session.ask_e2e(subject, network.id, "foo~", device.did, @hint)

      assert {:ok, _} =
               IRCServer.wait_for_line(
                 server,
                 &String.starts_with?(&1, "PRIVMSG foo~ :\x01E2E REQUEST "),
                 @consent_timeout
               )

      assert {:ok, _} = Session.send_e2e(subject, network.id, "foo~", :msg, :text, {device.did, @alice}, @small, nil)

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG foo~ :\x01E2E MSG "), @consent_timeout)
    end

    test "the doors refuse what is not a nick, a line outside the rule, an unlisted device, an unknown id, and no session" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      %{device: pairing} = register_device!(subject, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:error, :invalid_line} = Session.ask_e2e(subject, network.id, "al\r\nice", device.did, @hint)
      assert {:error, :bad_request} = Session.ask_e2e(subject, network.id, "#chan", device.did, @hint)
      assert {:error, :bad_request} = Session.ask_e2e(subject, network.id, "alice", "*", @hint)
      assert {:error, :bad_request} = Session.ask_e2e(subject, network.id, "alice", device.did, ~s({"v": 2}))

      big = String.duplicate("A", Request.max_payload_bytes() + 1)
      assert {:error, :bad_request} = Session.ask_e2e(subject, network.id, "alice", device.did, big)
      assert {:error, :unknown_device} = Session.ask_e2e(subject, network.id, "alice", pairing.did, @hint)
      assert E2eRequests.list(subject, network.id, DateTime.utc_now()) == []

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: id}}}, @wire_timeout

      assert {:error, :not_found} = Session.dismiss_e2e(subject, network.id, id + 1_000, nil)

      # Another subject reaches no request of this one: it has a session of
      # its own, or none, never this one.
      other = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      [theirs] = identity!({:user, other.id}, network, 1)
      assert {:error, :no_session} = Session.answer_e2e({:user, other.id}, network.id, id, :accept, {theirs.did, @hint})

      :ok = Session.stop_session(subject, network.id)
      assert {:error, :no_session} = Session.ask_e2e(subject, network.id, "alice", device.did, @hint)
      assert {:error, :no_session} = Session.dismiss_e2e(subject, network.id, id, nil)
    end

    test "the sweep withdraws an incoming request past its deadline from every device; an expired one we asked stays" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: alice}}}, @wire_timeout
      {:ok, %Request{id: bob}} = Session.ask_e2e(subject, network.id, "bob", device.did, @hint)

      age_request!(alice, E2eRequests.ttl_seconds() + 60)
      age_request!(bob, E2eRequests.ttl_seconds() + 60)
      sweep(pid)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, id: ^alice}}, @wire_timeout
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone}}, 200
      assert [%Request{id: ^bob} = expired] = E2eRequests.list(subject, network.id, DateTime.utc_now())
      assert E2eRequests.expired?(expired, DateTime.utc_now())
    end

    test "a 401 naming the peer we ask ends the asking on every device (issue 2497): the REQUEST reached nobody" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      {:ok, %Request{id: id}} = Session.ask_e2e(subject, network.id, "Ghost", device.did, @hint)
      _ = await_consent(server, "Ghost", :request)
      IRCServer.feed(server, ":irc 401 #{@nick} Ghost :No such nick/channel\r\n")

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone, network: slug, id: ^id}},
                     @wire_timeout

      assert slug == network.slug
      assert E2eRequests.for_peer(subject, network.id, "ghost") == nil
      assert Process.alive?(pid)
    end

    test "a 401 leaves every request that is not our live asking: the peer's, an answer, an expired one" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      [device] = listed(user, network)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(consent_from("alice", :request, @hint), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{id: alice}}}, @wire_timeout
      {:ok, %Request{id: bob}} = Session.ask_e2e(subject, network.id, "bob", device.did, @hint)
      _ = await_consent(server, "bob", :request)
      Enum.each(consent_from("bob", :accept, @hint), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request, request: %{state: :accepted}}},
                     @wire_timeout

      {:ok, %Request{id: carol}} = Session.ask_e2e(subject, network.id, "carol", device.did, @hint)
      age_request!(carol, E2eRequests.ttl_seconds() + 60)

      for nick <- ["alice", "bob", "carol"],
          do: IRCServer.feed(server, ":irc 401 #{@nick} #{nick} :No such nick/channel\r\n")

      # The last 401's own push, then a call behind it in the mailbox: the push
      # goes out before that 401's request is committed, so the call is what
      # says every 401 has been all the way through the session.
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :no_such_nick, nick: "carol"}}, @wire_timeout
      _ = :sys.get_state(pid)
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_request_gone}}
      assert subject |> E2eRequests.list(network.id, DateTime.utc_now()) |> Enum.map(& &1.id) == [alice, bob, carol]
    end
  end

  # The listed devices of the user on the network.
  defp listed(user, network), do: E2eKeys.listed_devices({:user, user.id}, network.id)

  # A consent line from `nick`'s device to the user (issue 2486).
  defp consent_from(nick, verb, payload), do: lines_from(nick, verb, E2e.new_msgid(), {@alice, "*"}, payload)

  # The consent line of `verb` grappa sent `nick`, once it is on the wire.
  defp await_consent(server, nick, verb) do
    {:ok, line} = IRCServer.wait_for_line(server, &match?(%{verb: ^verb}, fragment_to(&1, nick)), @consent_timeout)
    fragment_to(line, nick)
  end

  defp age_request!(id, seconds) do
    at = DateTime.truncate(DateTime.add(DateTime.utc_now(), -seconds, :second), :second)
    {1, _} = Request |> where([r], r.id == ^id) |> Repo.update_all(set: [updated_at: at])
    :ok
  end

  # A push subscription for `user` on a stub endpoint, and every push sent
  # reported to the test as `{:pushed, meta}`. The row goes in past the
  # changeset, as at every site here: Bypass is plain http on loopback,
  # which `Push.create/2` refuses since #2401 (see `Grappa.PushFixtures`).
  defp push_telemetry!(user) do
    bypass = Bypass.open()
    Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    stored_subscription!({:user, user.id}, %{
      endpoint: "http://localhost:#{bypass.port}/wp",
      p256dh_key: @client_p256dh,
      auth_key: @client_auth,
      user_agent: "Mozilla/5.0 e2e-session-test"
    })

    test_pid = self()
    handler = "e2e-push-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:grappa, :push, :send, :stop],
      fn _, _, meta, _ -> send(test_pid, {:pushed, meta}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    :ok
  end

  # A registered device, not listed: one being paired. Its signing identity
  # rides in the process dictionary, so a test can upload keys for it.
  defp register_device!(subject, network) do
    master = master_of(subject, network)
    %{identity: identity, attrs: attrs} = E2eFixtures.device(master)
    {:ok, device} = E2eKeys.register_device(subject, network.id, attrs)
    Process.put({:e2e_identity, device.did}, identity)
    %{device: device, identity: identity}
  end

  # One more device, registered and listed under a list one version up.
  defp add_listed_device!(subject, network) do
    %{device: device} = register_device!(subject, network)
    master = master_of(subject, network)

    {ver, keys} =
      case E2eKeys.list(subject, network.id) do
        {:ok, list} -> {list.ver + 1, list.devices}
        {:error, :not_found} -> {1, []}
      end

    {:ok, _} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, ver, [device.ed25519 | keys]))
    device
  end

  # A subject's E2E identity on a network: `n` devices, all listed. The
  # step keeps `1..0` empty instead of counting down.
  defp identity!(subject, network, n), do: for(_ <- 1..n//1, do: add_listed_device!(subject, network))

  # One master per (subject, network), made on first use.
  defp master_of(subject, network) do
    case Process.get({:e2e_master, subject, network.id}) do
      nil ->
        master = E2eFixtures.identity()
        Process.put({:e2e_master, subject, network.id}, master)
        master

      master ->
        master
    end
  end

  defp identity_of(device), do: Process.get({:e2e_identity, device.did})

  defp upload_otks!(device, n) do
    identity = identity_of(device)
    otks = for _ <- 1..n, do: E2eFixtures.signed_key(identity)
    {:ok, _} = E2eKeys.upload(device, %{one_time_keys: otks, fallback: nil})
    :ok
  end

  # A KEYREQ from `nick`'s device, then a MSG from the same nick to our
  # device: once the MSG has been queued (its push arrives), the session
  # has handled the KEYREQ, which reached it first.
  # The caller must be subscribed to the user topic.
  defp keyreq!(server, nick, user, network) do
    [device | _] = listed(user, network)
    sync = E2e.new_msgid()
    Enum.each(lines_from(nick, :keyreq, E2e.new_msgid(), {@alice, "*"}, @small), &IRCServer.feed(server, &1))
    Enum.each(lines_from(nick, :msg, sync, {@alice, device.did}, @small), &IRCServer.feed(server, &1))
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: ^sync}}, @wire_timeout
    :ok
  end

  defp lines_from(nick, verb, msgid, addresses, payload) do
    {:ok, lines} = E2e.fragment(verb, msgid, addresses, payload, LineSplit.frame_budget(@nick, 512))
    Enum.map(lines, &":#{nick}!u@h PRIVMSG #{@nick} :#{&1}\r\n")
  end

  # The same, to a channel: the frame is cut against the channel target
  # and the line goes to the channel, not to our nick.
  defp channel_lines_from(nick, verb, msgid, addresses, payload, channel) do
    {:ok, lines} = E2e.fragment(verb, msgid, addresses, payload, LineSplit.frame_budget(channel, 512))
    Enum.map(lines, &":#{nick}!u@h PRIVMSG #{channel} :#{&1}\r\n")
  end

  # Waits until the session's members map holds `channel`. A JOIN fed
  # from the fake ircd is async — the line crosses the socket and the
  # client before the session sees it — and a send that races it would
  # be refused as not-a-member.
  defp await_joined(pid, channel, timeout \\ 1_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    if Map.has_key?(:sys.get_state(pid).members, channel) do
      :ok
    else
      if System.monotonic_time(:millisecond) < deadline do
        Process.sleep(10)
        await_joined(pid, channel, deadline - System.monotonic_time(:millisecond))
      else
        flunk("session never joined #{channel}")
      end
    end
  end

  # Waits for the last line of a KEYS message to `nick`, checks it goes from
  # `*` to `asker`, and returns that message's payload, joined from its
  # lines and decoded.
  defp await_keys(server, nick, asker) do
    {:ok, last} =
      IRCServer.wait_for_line(
        server,
        &match?(%{verb: :keys, index: same, total: same}, fragment_to(&1, nick)),
        @keys_timeout
      )

    %{msgid: msgid, from: "*", to: ^asker} = fragment_to(last, nick)

    server
    |> IRCServer.sent_lines()
    |> Enum.map(&fragment_to(&1, nick))
    |> Enum.filter(&match?(%{msgid: ^msgid}, &1))
    |> Enum.sort_by(& &1.index)
    |> Enum.map_join(& &1.chunk)
    |> Jason.decode!()
  end

  # The E2E fragment a line sends to `nick`, or nil.
  defp fragment_to(line, nick) do
    with ["PRIVMSG " <> ^nick, body] <- line |> String.trim_trailing("\r\n") |> String.split(" :", parts: 2),
         {:ok, fragment} <- E2e.parse(body) do
      fragment
    else
      _ -> nil
    end
  end

  # Whether `line` is grappa's NACK to `nick` of the message `ref`: one
  # line, the payload irc-olm's NACK carries.
  defp nack_of?(line, nick, ref) do
    case fragment_to(line, nick) do
      %{verb: :nack, index: 1, total: 1, chunk: chunk} -> Jason.decode(chunk) == {:ok, %{"ref" => ref, "v" => 2}}
      _ -> false
    end
  end

  # Lines of `msgid` still waiting in the session's pacer, in any lane.
  defp queued_lines(pid, msgid) do
    for {_, lanes} <- :sys.get_state(pid).e2e_pacer.queues,
        {_, items} <- lanes,
        item <- items,
        item.msgid == msgid,
        reduce: 0,
        do: (n -> n + 1)
  end

  # A stand-in for the session's IRC client: the bank always reads empty, a
  # write to the raw target `failing` fails as on a closed socket, any other
  # goes through, and each attempt is reported to the test. It goes when
  # the session does.
  defp failing_client(session, failing) do
    test = self()

    spawn(fn ->
      ref = Process.monitor(session)
      stub_client(test, ref, "PRIVMSG #{failing} :")
    end)
  end

  defp stub_client(test, ref, failing) do
    receive do
      {:DOWN, ^ref, :process, _, _} ->
        :ok

      {:"$gen_call", from, :fake_lag_bank_ms} ->
        GenServer.reply(from, 0)
        stub_client(test, ref, failing)

      {:"$gen_call", from, {:send, frame}} ->
        if String.starts_with?(frame, failing) do
          send(test, {:failed, frame})
          GenServer.reply(from, {:error, :closed})
        else
          send(test, {:wrote, frame})
          GenServer.reply(from, :ok)
        end

        stub_client(test, ref, failing)
    end
  end

  # Every line of message `msgid` on the wire so far, parsed, in wire order.
  defp sent_fragments(server, msgid) do
    server
    |> IRCServer.sent_lines()
    |> Enum.filter(&String.contains?(&1, " #{msgid} "))
    |> Enum.map(fn line ->
      ["PRIVMSG alice", body] = line |> String.trim_trailing("\r\n") |> String.split(" :", parts: 2)
      {:ok, fragment} = E2e.parse(body)
      fragment
    end)
  end

  defp put_entry!(device, sender, verb) do
    {:ok, entry} =
      E2eInbox.put(device, %{sender: sender, from_did: @alice, verb: verb, msgid: "q83vEjRWeJA", payload: @small})

    entry
  end

  # Fills `sender`'s share of the device's queue to the byte (the share of
  # the subject's own copies when `own?`), so their next message is refused
  # while anybody else's still fits.
  defp fill_share!(device, sender, own?) do
    full = E2e.max_payload_bytes() + E2eInbox.row_overhead_bytes()
    rest = rem(E2eInbox.max_sender_bytes(), full)
    sizes = [rest | List.duplicate(full, div(E2eInbox.max_sender_bytes(), full))]

    Enum.each(sizes, fn size ->
      payload = String.duplicate("A", size - E2eInbox.row_overhead_bytes())
      attrs = %{sender: sender, from_did: @alice, verb: :msg, msgid: "q83vEjRWeJA", payload: payload, own: own?}
      {:ok, _} = E2eInbox.put(device, attrs)
    end)
  end

  defp age!(%E2eInbox.Entry{id: id}, seconds) do
    at = DateTime.truncate(DateTime.add(DateTime.utc_now(), -seconds, :second), :second)
    {1, _} = E2eInbox.Entry |> where([e], e.id == ^id) |> Repo.update_all(set: [inserted_at: at])
    :ok
  end

  # issue 2577 — every message part-way through reassembly made one timeout
  # older, as if its last line came that long ago: the session's clock is
  # monotonic and not injectable, and a test does not wait a minute.
  defp age_reassembly!(pid) do
    :sys.replace_state(pid, fn state ->
      buffer = state.e2e_reassembly

      older =
        Map.new(buffer.entries, fn {key, entry} ->
          {key, %{entry | last_ms: entry.last_ms - E2eReassembly.timeout_ms()}}
        end)

      %{state | e2e_reassembly: %{buffer | entries: older}}
    end)

    :ok
  end

  # The production tick, delivered now; the state read after it is the
  # barrier that says the session has handled it.
  defp sweep(pid) do
    send(pid, :e2e_inbox_sweep)
    _ = :sys.get_state(pid)
    :ok
  end

  defp notices(network) do
    Message
    |> where([m], m.network_id == ^network.id and m.kind == :server_event)
    |> Repo.all()
  end

  defp rows(network) do
    Message
    |> where([m], m.network_id == ^network.id)
    |> Repo.aggregate(:count)
  end

  # Rows that carry message text. A JOIN is a row too (`kind: :join`), so
  # the channel tests — which join first — count these, not `rows/1`:
  # the property is that no E2E line is ever stored as a message.
  defp text_rows(network) do
    Message
    |> where([m], m.network_id == ^network.id and m.kind in [:privmsg, :notice, :action])
    |> Repo.aggregate(:count)
  end

  # A live session for a fresh user whose E2E identity on the network is
  # one listed device.
  defp connected_session, do: connected_session(1)

  # The same with `devices` listed devices; with none, the subject has no
  # E2E identity on the network at all.
  defp connected_session(devices) do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})
    _ = identity!({:user, user.id}, network, devices)

    pid = start_session!(user, network)
    :ok = IRCServer.await_handshake(server, @wire_timeout)

    {server, pid, user, network}
  end

  defp start_session!(user, network) do
    subject = {:user, user.id}
    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))
    {:ok, pid} = Session.start_session(subject, network.id, plan)
    on_exit(fn -> Session.stop_session(subject, network.id) end)
    pid
  end
end
