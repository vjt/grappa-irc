defmodule Grappa.Session.PresencePushTest do
  @moduledoc """
  End-to-end gate for the `/notify` presence web push (#378).

  Drives the WHOLE path — real `Session.Server`, real `EventRouter`
  numerics off the `Grappa.IRCServer` fake ircd, real `Push.Triggers`
  dispatch, real `Push.Sender` fan-out against a Bypass vendor — because
  the two halves this issue can get wrong are only visible together:

    * a MONITOR **baseline** (730) must push NOTHING, however aggressive
      the prefs. That gate sits in `dispatch_presence/4`'s function head,
      so a connect-time burst spawns zero Tasks;
    * a live **transition** (731) must push, with the payload
      `Payload.build_presence/3` builds.

  Also pins the rename fix AND its measured limit. A watched peer renaming
  emits `731` (or `601`/`605`) for the freed nick, which without the
  presence reset in the `{:peer_nick_renamed, _}` arm would be a genuine
  `:transition` — "alice went offline" on the lockscreen about someone who
  merely renamed. That half is fixed. The other half the design claimed —
  silence when a DIFFERENT human takes the freed nick — is NOT bought by
  the reset, and the last test here pins that boundary rather than leaving
  it to be discovered in the field.

  `async: false` — `SessionRegistry` / `SessionSupervisor` / `WSPresence`
  are singletons, same rationale as `Grappa.Session.ServerTest`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Push, UserSettings, WSPresence}

  # Real P-256 client public key + auth secret (mirrors sender_test /
  # triggers_test); the encryption preamble crashes on random bytes.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"

  setup do
    :ok = WSPresence.reset_for_test()
    bypass = Bypass.open()
    {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/wp"}
  end

  defp attach_telemetry(events) do
    test_pid = self()
    handler_id = "presence-push-#{System.unique_integer([:positive])}"

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ -> send(test_pid, {:telemetry, event, measurements, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
  end

  # A subject watching "Foo" on a MONITOR network, subscribed to push, with
  # BOTH presence prefs on — so anything that stays silent below is silent
  # because of a gate, never because of a pref.
  defp watching_session(port, endpoint, autojoin) do
    user = user_fixture(name: "presence-push-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "pp-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{nick: "grappa-test", autojoin_channels: autojoin})
    subject = {:user, user.id}

    {:ok, _} = Grappa.Notify.add(subject, network.id, ["Foo"], user.name)

    {:ok, _} =
      Push.create(subject, %{
        endpoint: endpoint,
        p256dh_key: @client_p256dh,
        auth_key: @client_auth,
        user_agent: "Mozilla/5.0 presence-push-test"
      })

    {:ok, _} =
      UserSettings.put_notification_prefs(
        subject,
        Map.merge(UserSettings.default_notification_prefs(), %{
          presence_online: true,
          presence_offline: true
        })
      )

    {user, network, subject}
  end

  defp arm_monitor(server) do
    :ok = IRCServer.await_handshake(server, 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
    IRCServer.feed(server, ":irc.test.org 005 grappa-test MONITOR=100 :are supported\r\n")
    IRCServer.feed(server, ":irc.test.org 376 grappa-test :End of /MOTD command.\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "MONITOR + Foo\r\n"), 1_000)
    :ok
  end

  test "730 baseline pushes NOTHING; 731 transition pushes the presence payload", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])

    # The vendor request body is AES-GCM ciphertext — the assertion that the
    # right payload went out is the telemetry pair plus the parity-gated
    # builder, not a body match. What Bypass proves here is that exactly ONE
    # delivery reached a vendor across baseline + transition.
    test_pid = self()

    Bypass.expect(bypass, "POST", "/wp", fn conn ->
      send(test_pid, :vendor_hit)
      Plug.Conn.resp(conn, 201, "")
    end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject} = watching_session(port, endpoint, [])

    pid = start_session_for(user, network)
    :ok = arm_monitor(server)

    # 730 RPL_MONONLINE — the baseline snapshot for an already-online Foo.
    IRCServer.feed(server, ":irc.test.org 730 grappa-test :Foo!user@host\r\n")

    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 500
    refute_received :vendor_hit

    # 731 RPL_MONOFFLINE — a genuine transition.
    IRCServer.feed(server, ":irc.test.org 731 grappa-test :Foo\r\n")

    assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}},
                   2_000

    assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000
    assert_received :vendor_hit

    assert {:ok, %{"foo" => :offline}} = Grappa.Session.presence_snapshot(subject, network.id)

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "a watched peer RENAMING does not push — the freed nick's 731 is a baseline again", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    attach_telemetry([[:grappa, :push, :send, :start]])

    Bypass.stub(bypass, "POST", "/wp", fn conn ->
      Plug.Conn.resp(conn, 500, "should-not-happen")
    end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _} = watching_session(port, endpoint, ["#pp"])

    pid = start_session_for(user, network)
    :ok = arm_monitor(server)

    # IRC delivers a peer's NICK only to channel-sharing peers, so the rename
    # is only OBSERVABLE (and this fix only reachable) when Foo shares a
    # channel with us. Seed that membership — outside it, the design's stated
    # boundary applies and a rename is indistinguishable from a real part.
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#pp\r\n")
    IRCServer.feed(server, ":irc.test.org 353 grappa-test = #pp :grappa-test Foo\r\n")
    IRCServer.feed(server, ":irc.test.org 366 grappa-test #pp :End of /NAMES list.\r\n")

    # Baseline: Foo is online.
    IRCServer.feed(server, ":irc.test.org 730 grappa-test :Foo!user@host\r\n")
    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300

    # Foo renames to Bar. The presence entry for "foo" goes back to :unknown,
    # so the 731 the ircd sends for the vacated nick classifies :initial.
    IRCServer.feed(server, ":Foo!user@host NICK :Bar\r\n")
    IRCServer.feed(server, ":irc.test.org 731 grappa-test :Foo\r\n")

    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 500

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "someone ELSE taking the freed nick DOES push — the accepted #247 boundary", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    # #378's design listed this as a second thing the rename fix buys ("the
    # freed nick taken by someone else ⇒ no push"). MEASURED: it does not,
    # and it cannot with a single demotion. `reset/2` puts the entry back to
    # `:unknown`, and the vacancy report (731) CONSUMES that — it re-baselines
    # to `:offline`. The next online report for the nick is therefore a
    # genuine transition and pushes.
    #
    # Kept as behaviour rather than chased, because the alternative is a
    # second "vacated" state living beside the presence map — parallel state
    # needing housekeeping, for a case #247 already ruled on: the watch list
    # watches NICKS, not people. What the fix does buy is the FALSE half — no
    # "went offline" for a peer who is still here under a new nick — and that
    # is the assertion in the test above. This one pins the boundary so it is
    # a decision on the record, not a surprise in the field.
    attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])
    Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, subject} = watching_session(port, endpoint, ["#pp"])

    pid = start_session_for(user, network)
    :ok = arm_monitor(server)

    IRCServer.feed(server, ":grappa-test!u@h JOIN :#pp\r\n")
    IRCServer.feed(server, ":irc.test.org 353 grappa-test = #pp :grappa-test Foo\r\n")
    IRCServer.feed(server, ":irc.test.org 366 grappa-test #pp :End of /NAMES list.\r\n")

    IRCServer.feed(server, ":irc.test.org 730 grappa-test :Foo!user@host\r\n")
    IRCServer.feed(server, ":Foo!user@host NICK :Bar\r\n")
    IRCServer.feed(server, ":irc.test.org 731 grappa-test :Foo\r\n")
    refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 500

    IRCServer.feed(server, ":irc.test.org 730 grappa-test :Foo!other@host\r\n")

    assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}},
                   2_000

    # Await fan-out completion so the vendor POST has landed before `on_exit`
    # verifies the Bypass expectation.
    assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
