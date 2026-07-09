defmodule Grappa.Push.TriggersTest do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14).

  Two surfaces under test:

    * `Triggers.should_notify?/4` — pure predicate, testable in
      isolation with literal `Message{}` structs + literal prefs maps.
      Covers the full decision tree (DM all / DM whitelist / channel
      all / channel whitelist / channel mention / kind gate).
    * `Triggers.evaluate_and_dispatch/2` — fire-and-forget dispatcher
      that spawns a Task, fetches prefs from the DB, and invokes
      `Push.Sender.send_to_subject/2`. Tested end-to-end via Bypass +
      real `push_subscriptions` rows + `:telemetry` to observe the
      `[:grappa, :push, :send, :start | :stop]` events.

  The `should_notify?/4` test class is `async: true` (no DB).
  The `evaluate_and_dispatch/2` test class is `async: false`
  (DataCase + Bypass).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Push, UserSettings, Visitors, WSPresence}
  alias Grappa.Push.{Subscription, Triggers}
  alias Grappa.Scrollback.Message

  # Real P-256 client public key + auth secret (mirrors sender_test);
  # encryption preamble crashes on random bytes.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"

  defp msg(opts) do
    %Message{
      id: opts[:id] || 1,
      channel: opts[:channel] || "#sniffo",
      sender: opts[:sender] || "alice",
      body: opts[:body] || "hello",
      kind: opts[:kind] || :privmsg,
      server_time: 1_700_000_000_000
    }
  end

  defp default_prefs, do: UserSettings.default_notification_prefs()

  defp prefs(overrides), do: Map.merge(default_prefs(), Map.new(overrides))

  describe "should_notify?/4 — kind gate" do
    test "non-PRIVMSG kinds always return false" do
      for kind <- [:notice, :join, :part, :quit, :nick_change, :mode, :topic, :kick, :server_event] do
        m = msg(kind: kind, body: "vjt: ping")
        # Even with the most aggressive prefs (everything on, mention pattern matches)
        refute Triggers.should_notify?(
                 m,
                 "vjt",
                 prefs(channel_messages_all: true, channel_mentions: true),
                 ["vjt"]
               ),
               "kind #{kind} should never push"
      end
    end

    test ":privmsg passes the kind gate" do
      m = msg(kind: :privmsg, channel: "#sniffo", body: "vjt ping")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(channel_mentions: true),
               []
             )
    end

    test ":action (CTCP /me) passes the kind gate" do
      m = msg(kind: :action, channel: "#sniffo", body: "waves at vjt")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(channel_mentions: true),
               []
             )
    end
  end

  describe "should_notify?/4 — DM (channel == own_nick)" do
    test "private_messages_all=true → notify regardless of sender" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")
      assert Triggers.should_notify?(m, "vjt", prefs(private_messages_all: true), [])
    end

    test "private_messages_all=false + sender NOT in whitelist → no notify" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      refute Triggers.should_notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["bob"]),
               []
             )
    end

    test "private_messages_all=false + sender IN whitelist → notify" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["alice"]),
               []
             )
    end

    test "whitelist comparison is case-insensitive on sender" do
      m = msg(channel: "vjt", sender: "ALICE", body: "ping")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["alice"]),
               []
             )
    end

    test "whitelist match folds sender under rfc1459 — bracket → brace (#121)" do
      # bahamut CASEMAPPING=rfc1459 folds `[` → `{`, so foo[bar] and
      # foo{bar} are the SAME nick. The stored list is canonicalized to the
      # folded form (UserSettings.normalize_list), so an inbound foo[bar]
      # must fold to foo{bar} and match. A plain String.downcase leaves the
      # bracket untouched → whitelisted DM silently missed.
      m = msg(channel: "vjt", sender: "foo[bar]", body: "ping")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["foo{bar}"]),
               []
             )
    end

    test "whitelist match folds sender under rfc1459 — tilde → caret + case (#121)" do
      m = msg(channel: "vjt", sender: "Foo~Baz", body: "ping")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["foo^baz"]),
               []
             )
    end

    test "DM does NOT consider channel_messages flags" do
      # A DM with channel_messages_all=true but private_messages_all=false
      # should NOT notify — the DM branch is independent.
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      refute Triggers.should_notify?(
               m,
               "vjt",
               prefs(
                 channel_messages_all: true,
                 channel_mentions: true,
                 private_messages_all: false,
                 private_messages_only: []
               ),
               []
             )
    end
  end

  describe "should_notify?/4 — channel message" do
    test "channel_messages_all=true → notify regardless of body" do
      m = msg(channel: "#sniffo", body: "no mention here")
      assert Triggers.should_notify?(m, "vjt", prefs(channel_messages_all: true), [])
    end

    test "channel_messages_only hit → notify even when _all is off" do
      m = msg(channel: "#sniffo", body: "no mention here")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(channel_messages_all: false, channel_messages_only: ["#sniffo"]),
               []
             )
    end

    test "channel_messages_only is case-insensitive on channel name" do
      m = msg(channel: "#SNIFFO", body: "no mention here")

      assert Triggers.should_notify?(
               m,
               "vjt",
               prefs(channel_messages_all: false, channel_messages_only: ["#sniffo"]),
               []
             )
    end

    test "channel_mentions=true + body mentions own_nick → notify" do
      m = msg(channel: "#sniffo", body: "vjt: are you there?")
      assert Triggers.should_notify?(m, "vjt", prefs(channel_mentions: true), [])
    end

    test "channel_mentions=true + body matches highlight pattern → notify" do
      m = msg(channel: "#sniffo", body: "oncall page incoming")
      assert Triggers.should_notify?(m, "vjt", prefs(channel_mentions: true), ["oncall"])
    end

    test "channel_mentions=false → mention does NOT notify" do
      m = msg(channel: "#sniffo", body: "vjt: ping")
      refute Triggers.should_notify?(m, "vjt", prefs(channel_mentions: false), [])
    end

    test "all flags off + no whitelist hit + no mention → no notify" do
      m = msg(channel: "#sniffo", body: "no mention")
      refute Triggers.should_notify?(m, "vjt", prefs([]), [])
    end

    test "channel mention is word-boundary (substring does NOT match)" do
      m = msg(channel: "#sniffo", body: "vjtbot is paged")
      refute Triggers.should_notify?(m, "vjt", prefs(channel_mentions: true), [])
    end
  end

  # ---------------------------------------------------------------------------
  # evaluate_and_dispatch/2 — end-to-end with Bypass + real subscription
  # ---------------------------------------------------------------------------

  defp user_fixture do
    name = "trigger-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp visitor_fixture do
    nick = "trigger-visitor-#{System.unique_integer([:positive])}"
    {:ok, v} = Visitors.find_or_provision_anon(nick, "libera", "127.0.0.1")
    v
  end

  defp subscription_fixture(subject, endpoint) do
    {:ok, sub} =
      Push.create(subject, %{
        endpoint: endpoint,
        p256dh_key: @client_p256dh,
        auth_key: @client_auth,
        user_agent: "Mozilla/5.0 trigger-test"
      })

    sub
  end

  defp attach_telemetry(events) do
    test_pid = self()
    handler_id = "trigger-test-#{System.unique_integer([:positive])}"

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ ->
        send(test_pid, {:telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
  end

  describe "evaluate_and_dispatch/2 — fire-and-forget dispatch" do
    setup do
      bypass = Bypass.open()
      {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/wp"}
    end

    test "matching PRIVMSG → Sender.send_to_subject fires (telemetry observed)", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])

      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      # Default prefs have channel_mentions: true, so a body mentioning
      # "vjt" on a channel triggers notify.
      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}},
                     2_000

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000
    end

    test "VISITOR matching PRIVMSG → Sender fires for visitor subscription — V3", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])
      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}
      _ = subscription_fixture(subject, endpoint)

      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: "visitor:" <> visitor.id,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}},
                     2_000

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000
    end

    test "non-matching PRIVMSG → no Sender call (no telemetry)", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start]])

      # Bypass should NEVER receive a request — assert that via no
      # telemetry start event firing within the timeout.
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      # No mention, no whitelist, _all flags default off for channel.
      m = msg(channel: "#sniffo", sender: "alice", body: "no mention here")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "non-PRIVMSG kind → short-circuit, no Task spawned, no telemetry", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start]])
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      m = msg(kind: :join, channel: "#sniffo", sender: "alice", body: nil)

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "subject with no subscriptions → match still safe (Sender no-op)", %{
      bypass: _bypass,
      endpoint: _endpoint
    } do
      # Sender.send_to_subject/2 short-circuits on empty subs list and
      # emits no telemetry — verify the dispatcher tolerates that.
      attach_telemetry([[:grappa, :push, :send, :start]])

      user = user_fixture()
      # No subscription_fixture/2 call.

      m = msg(channel: "vjt", sender: "alice", body: "ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: {:user, user.id},
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "honors stored notification_prefs — _all=false + no whitelist + no mention skips", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start]])
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      # Override defaults: channel_mentions OFF
      {:ok, _} =
        UserSettings.put_notification_prefs(subject, %{
          channel_messages_all: false,
          channel_messages_only: [],
          channel_mentions: false,
          private_messages_all: true,
          private_messages_only: []
        })

      # Mention body but mentions OFF → no notify
      m = msg(channel: "#sniffo", sender: "alice", body: "vjt ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "Sender.send_to_subject persists last_used_at on success", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)
      attach_telemetry([[:grappa, :push, :send, :stop]])

      user = user_fixture()
      subject = {:user, user.id}
      sub = subscription_fixture(subject, endpoint)
      assert is_nil(sub.last_used_at)

      m = msg(channel: "vjt", sender: "alice", body: "ping")

      :ok =
        Triggers.evaluate_and_dispatch(m, %{
          subject: subject,
          subject_label: user.name,
          network_slug: "libera",
          own_nick: "vjt"
        })

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000

      reloaded = Repo.get!(Subscription, sub.id)
      refute is_nil(reloaded.last_used_at)
    end
  end

  # ---------------------------------------------------------------------------
  # evaluate_and_dispatch/2 — foreground visibility gate (#182)
  #
  # When ANY of the subject's devices reports the PWA is on-screen, the
  # server suppresses the ENTIRE push fan-out — it never calls
  # Sender.send_to_subject, so NO start/stop telemetry fires. The gate
  # reads WSPresence.any_visible?/1 (RAW, no debounce) keyed by the
  # subject_label threaded from Session.Server.
  # ---------------------------------------------------------------------------

  describe "evaluate_and_dispatch/2 — foreground visibility gate (#182)" do
    setup do
      :ok = WSPresence.reset_for_test()
      bypass = Bypass.open()
      {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/wp"}
    end

    test "a VISIBLE device suppresses the whole fan-out (no telemetry) even when should_notify?",
         %{bypass: bypass, endpoint: endpoint} do
      attach_telemetry([[:grappa, :push, :send, :start]])
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      # Register a device for this user (subject_label == user.name) and
      # mark it visible → the gate must suppress.
      device = spawn(fn -> Process.sleep(:infinity) end)
      :ok = WSPresence.register(user.name, device)
      :ok = WSPresence.set_visibility(user.name, device, true)
      assert WSPresence.any_visible?(user.name)

      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300

      Process.exit(device, :kill)
    end

    test "a HIDDEN device does NOT suppress — the push still fires", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])
      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, endpoint)

      # Device connected but backgrounded (default :hidden) → gate open.
      device = spawn(fn -> Process.sleep(:infinity) end)
      :ok = WSPresence.register(user.name, device)
      refute WSPresence.any_visible?(user.name)

      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: user.name,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}},
                     2_000

      # Wait for fan-out completion so the Bypass HTTP POST has landed
      # before on_exit verifies the `expect` (stop fires after fan-out).
      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{subject: ^subject}}, 2_000

      Process.exit(device, :kill)
    end

    test "VISITOR with a visible device is suppressed too (gate applies to visitor subjects)", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start]])
      Bypass.stub(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 500, "should-not-happen") end)

      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}
      label = "visitor:" <> visitor.id
      _ = subscription_fixture(subject, endpoint)

      device = spawn(fn -> Process.sleep(:infinity) end)
      :ok = WSPresence.register(label, device)
      :ok = WSPresence.set_visibility(label, device, true)
      assert WSPresence.any_visible?(label)

      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 subject: subject,
                 subject_label: label,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300

      Process.exit(device, :kill)
    end
  end
end
