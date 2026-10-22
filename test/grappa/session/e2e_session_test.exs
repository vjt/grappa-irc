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

  alias Grappa.{E2eInbox, E2eKeys, IRCServer, Push, QueryWindows, Repo, Session}
  alias Grappa.IRC.{Client, E2e, LineSplit}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Message
  alias Grappa.Session.{E2eKeyAnswers, E2ePacer}

  @nick "grappa-test"

  # A real P-256 client key and auth secret (as in `Grappa.Push.TriggersTest`):
  # the web-push encryption runs on them before anything is sent.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"
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

    # The queue keys a message on its sender's nick, and refuses a row
    # whose sender is not one. A server prefix, a prefix-less line (`*`)
    # and a nick past our 30-character key are all reachable from the wire,
    # so they are dropped where the line is routed, not left to kill the
    # session at the queue.
    test "an E2E line whose sender is not a nick is dropped and the session survives" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      [line] = peer_lines(:msg, "q83vEjRWeJA", Base.encode64(~s({"v":1})))
      body = line |> String.split(" :", parts: 2) |> List.last()

      IRCServer.feed(server, ":irc.example.net PRIVMSG #{@nick} :#{body}")
      IRCServer.feed(server, "PRIVMSG #{@nick} :#{body}")
      IRCServer.feed(server, ":#{String.duplicate("a", 31)}!u@h PRIVMSG #{@nick} :#{body}")
      IRCServer.feed(server, line)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message}}
      assert Process.alive?(pid)
      assert [%E2eInbox.Entry{sender: "alice"}] = E2eInbox.list({:user, user.id}, network.id, 0)
    end
  end

  describe "KEYREQ answered from the hosted bundle" do
    test "a KEYREQ is answered with the oldest one-time key, framed as KEYS; nothing reaches the client or the database" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      [first, _] = otks = [keys_payload(false), keys_payload(false)]
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks, fallback: keys_payload(true)})
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice")

      assert await_keys(server, "alice") == first
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 1, fallback: true}
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, verb: :keyreq}}
      assert [%E2eInbox.Entry{verb: :msg}] = E2eInbox.list(subject, network.id, 0)
      assert rows(network) == 0
    end

    test "a nick asking again within 15 s is not answered; another nick is, with the next key" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      subject = {:user, user.id}
      fallback = keys_payload(true)
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: [], fallback: fallback})

      # No one-time key yet: alice gets the fallback key, which leaves her
      # free to take a one-time key next time — unless she asks too soon.
      keyreq!(server, "alice")
      assert await_keys(server, "alice") == fallback
      # Recorded as what she got, not what she was allowed: a one-time key
      # stays hers to take once the 15 s are up.
      refute Map.has_key?(:sys.get_state(pid).e2e_key_answers.otk_given, "alice")

      otk = keys_payload(false)
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: [otk], fallback: nil})
      keyreq!(server, "Alice")
      assert E2eKeys.status(subject, network.id).one_time_keys == 1

      keyreq!(server, "bob")
      assert await_keys(server, "bob") == otk
      assert E2eKeys.status(subject, network.id).one_time_keys == 0
    end

    test "answers stop at the connection's KEYS budget, however many nicks ask" do
      {server, _, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      subject = {:user, user.id}
      [payload | _] = payloads = for _ <- 1..9, do: keys_payload(false)
      asking = for n <- 1..9, do: "peer#{n}"
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: payloads, fallback: nil})

      # What one answer costs, from the framing and the fake-lag cost the
      # session uses: every nick here has the same length, so every answer
      # costs the same.
      {:ok, bodies} = E2e.fragment(:keys, E2e.new_msgid(), payload, LineSplit.frame_budget("peer1", 512))
      cost = bodies |> Enum.map(&Client.privmsg_cost_ms("peer1", &1)) |> Enum.sum()
      fit = div(E2eKeyAnswers.bank_budget_ms(), cost)
      assert fit in 1..8

      Enum.each(asking, &keyreq!(server, &1))

      assert E2eKeys.status(subject, network.id).one_time_keys == 9 - fit
    end

    test "the answer is reactive: ahead of the text already waiting for that peer" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: [keys_payload(false)], fallback: nil})

      # A long text message to alice: its first lines fill the bank, the
      # rest wait on it at about one line per 5 s.
      {:ok, text} = Session.send_e2e(subject, network.id, "alice", :msg, :text, payload(1600))
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, " #{text} 1/"), 10_000)
      [%{total: total} | _] = sent_fragments(server, text)
      assert total >= 6

      keyreq!(server, "alice")
      _ = await_keys(server, "alice")

      # The whole answer is out while the text still drips: it did not wait
      # behind the text in alice's queue.
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, " #{text} #{total}/#{total} "))
    end

    test "a KEYREQ the pacer cannot take spends no one-time key" do
      {server, _, user, network} = connected_session()
      subject = {:user, user.id}
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: [keys_payload(false)], fallback: nil})

      # Fill alice's reactive lane, where the answer would go, with our
      # own NACKs: one line each.
      small = Base.encode64(~s({"v":1}))

      refused =
        Enum.find(1..(E2ePacer.max_lane_lines() + 10), fn _ ->
          Session.send_e2e(subject, network.id, "alice", :nack, :text, small) == {:error, :rate_limited}
        end)

      assert refused, "alice's reactive lane never filled"

      keyreq!(server, "alice")

      assert E2eKeys.status(subject, network.id).one_time_keys == 1
    end

    test "with no bundle a KEYREQ goes unanswered and the session carries on" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      keyreq!(server, "alice")

      assert Process.alive?(pid)
      assert E2eKeys.status({:user, user.id}, network.id) == %{one_time_keys: 0, fallback: false}
      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "E2E KEYS"))
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

    test "refused key material and NACKs are not counted: there was no message to tell about" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
      fill_share!({:user, user.id}, network.id, "alice")

      Enum.each(peer_lines(:keys, "AAAAAAAAAAA", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      Enum.each(peer_lines(:nack, "BBBBBBBBBBB", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      Enum.each(bob_lines(:msg, "CCCCCCCCCCC", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "bob"}}, @wire_timeout
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, from: "alice"}}

      sweep(pid)

      assert notices(network) == []
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

    test "a queued PKMSG or MSG pushes a notification; key material and NACKs do not" do
      {server, _, user, _} = connected_session()
      bypass = Bypass.open()
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      {:ok, _} =
        Push.create({:user, user.id}, %{
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

      Enum.each(peer_lines(:keys, "AAAAAAAAAAA", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      Enum.each(peer_lines(:nack, "BBBBBBBBBBB", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      refute_receive {:pushed, _}, 500

      Enum.each(peer_lines(:msg, "CCCCCCCCCCC", Base.encode64(~s({"v":1}))), &IRCServer.feed(server, &1))
      assert_receive {:pushed, %{subject: {:user, _}}}, 2_000
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
    # The pacer's lanes are keyed on the folded nick (the session folds),
    # and nothing else pins that: two spellings of one peer must share one
    # queue, or each spelling gets its own FLUD window and its own bound.
    # The per-peer text bound is what tells one lane from two here.
    test "two spellings of one nick share one queue: its bound refuses both" do
      {_, _, user, network} = connected_session()
      subject = {:user, user.id}
      small = Base.encode64(~s({"v":1}))

      refused =
        Enum.find(1..(E2ePacer.max_text_messages() + 10), fn _ ->
          Session.send_e2e(subject, network.id, "Bob", :msg, :text, small) == {:error, :rate_limited}
        end)

      assert refused, "Bob's queue never filled"
      assert {:error, :rate_limited} = Session.send_e2e(subject, network.id, "bob", :msg, :text, small)
      assert {:ok, _} = Session.send_e2e(subject, network.id, "carol", :msg, :text, small)
    end

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

    test "a line that fails to go out drops the rest of its message at once" do
      {server, pid, user, network} = connected_session()

      # A long text message: one full line leaves, the rest drip on the bank.
      {:ok, msgid} = Session.send_e2e({:user, user.id}, network.id, "alice", :msg, :text, payload(1600))
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, " #{msgid} 1/"), 10_000)
      waiting = queued_lines(pid, msgid)
      assert waiting >= 2

      # Every write fails from here on, as with no socket to write to.
      :sys.replace_state(pid, &%{&1 | client: nil})

      # The first line that fails takes the whole rest of its message with
      # it: the receiver could never complete it.
      assert wait_until(fn -> queued_lines(pid, msgid) < waiting end, 10_000)
      assert queued_lines(pid, msgid) == 0
      assert :sys.get_state(pid).e2e_pacer.open == %{}
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

  # A KEYS payload as the agreed 2430 shape builds it: padded standard
  # base64 of JSON whose keys and signatures are unpadded base64. About
  # 450 bytes, two lines on a 512-byte wire, like a real one.
  defp keys_payload(fallback?) do
    b64 = &Base.encode64(:crypto.strong_rand_bytes(&1), padding: false)
    id = ~s({"curve25519":"#{b64.(32)}","ed25519":"#{b64.(32)}","sig":"#{b64.(64)}"})
    Base.encode64(~s({"v":1,"id":#{id},"otk":{"key":"#{b64.(32)}","fallback":#{fallback?},"sig":"#{b64.(64)}"}}))
  end

  # A KEYREQ from `nick`, then a MSG from the same nick: once the MSG has
  # been queued (its push arrives), the session has handled the KEYREQ,
  # which reached it first.
  # The caller must be subscribed to the user topic.
  defp keyreq!(server, nick) do
    sync = E2e.new_msgid()
    small = Base.encode64(~s({"v":1}))
    Enum.each(lines_from(nick, :keyreq, E2e.new_msgid(), small), &IRCServer.feed(server, &1))
    Enum.each(lines_from(nick, :msg, sync, small), &IRCServer.feed(server, &1))
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_message, msgid: ^sync}}, @wire_timeout
    :ok
  end

  defp lines_from(nick, verb, msgid, payload) do
    {:ok, lines} = E2e.fragment(verb, msgid, payload, LineSplit.frame_budget(@nick, 512))
    Enum.map(lines, &":#{nick}!u@h PRIVMSG #{@nick} :#{&1}\r\n")
  end

  # Waits for the last line of a KEYS message to `nick`, then returns that
  # message's payload, joined from its lines.
  defp await_keys(server, nick) do
    {:ok, last} = IRCServer.wait_for_line(server, &match?(%{index: same, total: same}, keys_fragment(&1, nick)), 15_000)
    %{msgid: msgid} = keys_fragment(last, nick)

    server
    |> IRCServer.sent_lines()
    |> Enum.map(&keys_fragment(&1, nick))
    |> Enum.filter(&match?(%{msgid: ^msgid}, &1))
    |> Enum.sort_by(& &1.index)
    |> Enum.map_join(& &1.chunk)
  end

  defp keys_fragment(line, nick) do
    with ["PRIVMSG " <> ^nick, body] <- line |> String.trim_trailing("\r\n") |> String.split(" :", parts: 2),
         {:ok, %{verb: :keys} = fragment} <- E2e.parse(body) do
      fragment
    else
      _ -> nil
    end
  end

  # Every line of message `msgid` on the wire so far, parsed, in wire order.
  # Lines of `msgid` still waiting in the session's pacer, in any lane.
  defp queued_lines(pid, msgid) do
    for {_, lanes} <- :sys.get_state(pid).e2e_pacer.queues,
        {_, items} <- lanes,
        item <- items,
        item.msgid == msgid,
        reduce: 0,
        do: (n -> n + 1)
  end

  defp wait_until(check, timeout_ms) when timeout_ms <= 0, do: check.()

  defp wait_until(check, timeout_ms) do
    check.() or
      (
        Process.sleep(50)
        wait_until(check, timeout_ms - 50)
      )
  end

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
