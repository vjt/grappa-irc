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

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor` and `Grappa.PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{E2eInbox, IRCServer, QueryWindows, Repo, Session}
  alias Grappa.IRC.{E2e, LineSplit}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Message

  @nick "grappa-test"
  @wire_timeout 1_000

  # The padded base64 of a JSON payload, the agreed 2430 shape; big enough
  # to need several lines on a 512-byte wire.
  defp payload(bytes), do: Base.encode64(~s({"v":1,"body":"#{Base.encode64(:crypto.strong_rand_bytes(bytes))}"}))

  # The peer's client cuts its lines against its own budget; any budget
  # that fits the wire will do, the receiver must not care.
  defp peer_lines(verb, msgid, payload) do
    {:ok, lines} = E2e.fragment(verb, msgid, payload, LineSplit.frame_budget(@nick, 512))
    Enum.map(lines, &":alice!u@h PRIVMSG #{@nick} :#{&1}\r\n")
  end

  describe "inbound" do
    test "a multi-line message reaches the user topic whole, and nothing is stored" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      payload = payload(900)
      lines = peer_lines(:pkmsg, "q83vEjRWeJA", payload)
      assert length(lines) > 1

      Enum.each(lines, &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message} = event}, @wire_timeout

      # The id is the queue's: the client acknowledges it, and a redelivery
      # carries the same one.
      assert [%E2eInbox.Entry{id: id, payload: ^payload}] = E2eInbox.list({:user, user.id}, network.id, 0)

      assert event == %{
               kind: :e2e_message,
               id: id,
               network: network.slug,
               from: "alice",
               verb: :pkmsg,
               msgid: "q83vEjRWeJA",
               payload: payload
             }

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}, 100

      assert Process.alive?(pid)
      assert rows(network) == 0
    end

    test "malformed, channel and NOTICE E2E lines are dropped and the session survives" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [line] = peer_lines(:msg, "q83vEjRWeJA", Base.encode64(~s({"v":1})))
      body = line |> String.split(" :", parts: 2) |> List.last()

      IRCServer.feed(server, ":alice!u@h PRIVMSG #{@nick} :\x01E2E MSG q83vEjRWeJA 0/1 eyJ2IjoxfQ==\x01\r\n")
      IRCServer.feed(server, ":alice!u@h PRIVMSG #{@nick} :\x01E2E OFFLINE q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01\r\n")
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

    test "a KEYREQ is not handed to the client (grappa will answer it itself)" do
      {server, _, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      Enum.each(peer_lines(:keyreq, "AAAAAAAAAAA", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      Enum.each(peer_lines(:msg, "BBBBBBBBBBB", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "BBBBBBBBBBB"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: "AAAAAAAAAAA"}}
      assert [%E2eInbox.Entry{msgid: "BBBBBBBBBBB"}] = E2eInbox.list({:user, user.id}, network.id, 0)
      assert rows(network) == 0
    end
  end

  describe "offline queue" do
    test "a message the queue refuses is not pushed, and the recipient is told on the next sweep" do
      {server, pid, user, network} = connected_session()
      subject = {:user, user.id}
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!(subject, network.id, "alice")

      Enum.each(peer_lines(:msg, "q83vEjRWeJA", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      Enum.each(peer_lines(:msg, "BBBBBBBBBBB", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      # bob's message is the barrier: once it is out, alice's lines are in.
      Enum.each(bob_lines(:msg, "CCCCCCCCCCC", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}

      sweep(pid)

      assert [notice] = notices(network)
      assert {notice.channel, notice.sender, notice.meta} == {"alice", "alice", %{e2e_undeliverable: 2}}
      # Told once: the count went out with the notice.
      sweep(pid)
      assert length(notices(network)) == 1
    end

    test "the sweep drops what expired and leaves one notice per sender, in that sender's query window" do
      {_, pid, user, network} = connected_session()
      subject = {:user, user.id}
      old = Enum.map(["Alice", "alice", "bob"], &put_entry!(subject, network.id, &1, :msg))
      keys = put_entry!(subject, network.id, "carol", :keys)
      fresh = put_entry!(subject, network.id, "alice", :msg)
      Enum.each([keys | old], &age!(&1, E2eInbox.ttl_seconds() + 60))

      sweep(pid)

      assert [%E2eInbox.Entry{id: id}] = E2eInbox.list(subject, network.id, 0)
      assert id == fresh.id

      # Not scrollback content: no body, no DM thread — a typed row the
      # client renders, filed under the peer's query window.
      assert [a, b] = Enum.sort_by(notices(network), & &1.channel)
      assert {a.channel, a.sender, a.dm_with, a.body, a.meta} == {"alice", "alice", nil, nil, %{e2e_undeliverable: 2}}
      assert {b.channel, b.sender, b.meta} == {"bob", "bob", %{e2e_undeliverable: 1}}
      assert QueryWindows.open?(subject, network.id, "alice")
      assert QueryWindows.open?(subject, network.id, "bob")
      refute QueryWindows.open?(subject, network.id, "carol")
    end

    test "a session sweeps what expired while it was down as soon as it starts" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
      {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
      _ = credential_fixture(user, network, %{})
      subject = {:user, user.id}
      entry = put_entry!(subject, network.id, "alice", :pkmsg)
      age!(entry, E2eInbox.ttl_seconds() + 60)

      pid = start_session!(user, network)
      :ok = IRCServer.await_handshake(server, @wire_timeout)
      _ = :sys.get_state(pid)

      assert [%Message{channel: "alice", meta: %{e2e_undeliverable: 1}}] = notices(network)
      assert E2eInbox.list(subject, network.id, 0) == []
    end
  end

  describe "outbound" do
    test "a message goes out as lines that fit the relay, reassemble, wait on the fake-lag bank, and are never stored" do
      {server, _, user, network} = connected_session()
      payload = payload(800)

      assert {:ok, msgid} = Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, payload)
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
      assert Enum.all?(fragments, &(&1.verb == :msg))
      assert fragments |> Enum.sort_by(& &1.index) |> Enum.map_join(& &1.chunk) == payload

      # The ircd relays `:<nick>!<user>@<host> PRIVMSG alice :<body>\r\n`; the
      # budget reserved the worst-case prefix, so the client's own line is
      # shorter than 512 by at least that reserve.
      reserve = LineSplit.relay_frame_overhead("alice") - byte_size("PRIVMSG alice :\r\n")
      lines = server |> IRCServer.sent_lines() |> Enum.filter(&String.contains?(&1, msgid))
      assert Enum.all?(lines, &(byte_size(&1) <= 512 - reserve))

      assert rows(network) == 0
    end

    test "a client that cannot answer holds the line instead of killing the session" do
      # The bank read is a call into the client, and the client stops
      # answering while it connects (up to 30 s per address) or sits on a
      # stuck write. Issue 2370's lesson: that must never take the session
      # down. Here the session queues the line and asks again later.
      {server, pid, user, network} = connected_session()
      # Registration's own last write (the umode query) must be done first,
      # or the session is still inside THAT call when the client freezes.
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE "), 1_000)
      client = :sys.get_state(pid).client
      :ok = :sys.suspend(client)

      assert {:ok, msgid} = Session.send_e2e({:user, user.id}, network.id, "alice", :keyreq, :control, "eyJ2IjoxfQ==")
      assert Process.alive?(pid)

      :ok = :sys.resume(client)
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 10_000)
    end

    test "refuses what is not a nick, a verb a client may not send, an unknown priority, and a non-base64 payload" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      good = Base.encode64(~s({"v":1}))

      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "#italia", :msg, :text, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :keys, :text, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :offline, :text, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :msg, :urgent, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :msg, :text, "not base64!")
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :msg, :text, "")
      assert {:error, :invalid_line} = Session.send_e2e(subject, network.id, "alice\r\nQUIT", :msg, :text, good)
    end

    test "a payload that needs more than 64 lines is refused before anything is sent" do
      {server, _, user, network} = connected_session()
      # Under the 32 KiB door bound, so it is the session's cut that refuses.
      huge = Base.encode64(:crypto.strong_rand_bytes(20_000))
      assert byte_size(huge) < E2e.max_payload_bytes()

      assert {:error, :too_large} = Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, huge)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
    end

    test "with no session the send is refused, not swallowed" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      assert {:error, :no_session} = Session.send_e2e({:user, user.id}, 999_999, "alice", :msg, :text, "eyJ2IjoxfQ==")
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

  defp bob_lines(verb, msgid, payload) do
    {:ok, lines} = E2e.fragment(verb, msgid, payload, LineSplit.frame_budget(@nick, 512))
    Enum.map(lines, &":bob!u@h PRIVMSG #{@nick} :#{&1}\r\n")
  end

  defp put_entry!(subject, network_id, sender, verb) do
    {:ok, entry} =
      E2eInbox.put(subject, network_id, %{sender: sender, verb: verb, msgid: "q83vEjRWeJA", payload: "eyJ2IjoxfQ"})

    entry
  end

  # Fills `sender`'s share of the queue to the byte, so their next message
  # is refused while anybody else's still fits.
  defp fill_share!(subject, network_id, sender) do
    full = E2e.max_payload_bytes() + E2eInbox.row_overhead_bytes()
    rest = rem(E2eInbox.max_sender_bytes(), full)
    sizes = [rest | List.duplicate(full, div(E2eInbox.max_sender_bytes(), full))]

    Enum.each(sizes, fn size ->
      payload = String.duplicate("A", size - E2eInbox.row_overhead_bytes())

      {:ok, _} =
        E2eInbox.put(subject, network_id, %{sender: sender, verb: :msg, msgid: "q83vEjRWeJA", payload: payload})
    end)
  end

  defp age!(%E2eInbox.Entry{id: id}, seconds) do
    at = DateTime.truncate(DateTime.add(DateTime.utc_now(), -seconds, :second), :second)
    {1, _} = E2eInbox.Entry |> where([e], e.id == ^id) |> Repo.update_all(set: [inserted_at: at])
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

  defp connected_session do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})

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
