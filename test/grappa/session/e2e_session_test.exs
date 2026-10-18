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

  alias Grappa.IRC.{E2e, LineSplit}
  alias Grappa.{IRCServer, Repo, Session}
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

      assert event == %{
               kind: :e2e_message,
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
      assert rows(network) == 0
    end
  end

  describe "outbound" do
    test "a message goes out as lines that fit the relay, reassemble, wait on the fake-lag bank, and are never stored" do
      {server, _, user, network} = connected_session()
      payload = payload(450)

      assert {:ok, msgid} = Session.send_e2e({:user, user.id}, network.id, "alice", :msg, payload)
      assert E2e.msgid?(msgid)

      # A full line costs 5 s of bahamut fake lag and registration left
      # several seconds in the bank, so the lines wait on the CONNECTION's
      # bank (read from the client): two FULL lines leave at least 5 s
      # apart, more if anything else was sent in between. The per-recipient
      # FLUD rule alone would send three at once. Lines 1 and 2 of a 3+ line
      # message are both full; the last one may be short and cheaper.
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} 1/"), 10_000)
      first_at = System.monotonic_time(:millisecond)
      [%{total: total}] = sent_fragments(server, msgid)
      assert total >= 3
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{msgid} 2/"), 10_000)
      gap = System.monotonic_time(:millisecond) - first_at
      assert gap >= 4_500, "the second line left #{gap} ms after the first"
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

    test "refuses what is not a nick, a verb a client may not send, and a non-base64 payload" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      good = Base.encode64(~s({"v":1}))

      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "#italia", :msg, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :keys, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :offline, good)
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :msg, "not base64!")
      assert {:error, :bad_request} = Session.send_e2e(subject, network.id, "alice", :msg, "")
      assert {:error, :invalid_line} = Session.send_e2e(subject, network.id, "alice\r\nQUIT", :msg, good)
    end

    test "a payload that needs more than 64 lines is refused before anything is sent" do
      {server, _, user, network} = connected_session()
      # Under the 32 KiB door bound, so it is the session's cut that refuses.
      huge = Base.encode64(:crypto.strong_rand_bytes(20_000))
      assert byte_size(huge) < E2e.max_payload_bytes()

      assert {:error, :too_large} = Session.send_e2e({:user, user.id}, network.id, "alice", :msg, huge)
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E"))
    end

    test "with no session the send is refused, not swallowed" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      assert {:error, :no_session} = Session.send_e2e({:user, user.id}, 999_999, "alice", :msg, "eyJ2IjoxfQ==")
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

    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

    subject = {:user, user.id}
    {:ok, pid} = Session.start_session(subject, network.id, plan)
    on_exit(fn -> Session.stop_session(subject, network.id) end)

    :ok = IRCServer.await_handshake(server, @wire_timeout)

    {server, pid, user, network}
  end
end
