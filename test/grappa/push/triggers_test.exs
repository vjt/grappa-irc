defmodule Grappa.Push.TriggersTest do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14).

  Two surfaces under test:

    * `Triggers.should_notify?/5` — pure predicate, testable in
      isolation with literal `Message{}` structs + literal prefs maps.
      Covers the full decision tree (DM all / DM whitelist / channel
      all / channel whitelist / channel mention / kind gate).
    * `Triggers.evaluate_and_dispatch/2` — fire-and-forget dispatcher
      that spawns a Task, fetches prefs from the DB, and invokes
      `Push.Sender.send_to_subject/2`. Tested end-to-end via Bypass +
      real `push_subscriptions` rows + `:telemetry` to observe the
      `[:grappa, :push, :send, :start | :stop]` events.

  The `should_notify?/5` test class is `async: true` (no DB).
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

  # #1038 — the predicate grew a `network_slug` because the mute key carries
  # the network. Every branch BELOW the mute (kind gate, DM, channel, own-row)
  # is network-independent, so they run through this fixed-slug wrapper rather
  # than repeating a constant 23 times. The mute branch does NOT use it: those
  # tests call `Triggers.should_notify?/5` directly with two different slugs,
  # which is the only way the new argument can be seen to matter.
  @slug "azzurra"

  defp notify?(message, own_nick, prefs, patterns),
    do: Triggers.should_notify?(message, @slug, own_nick, prefs, patterns)

  describe "should_notify?/5 — kind gate" do
    test "non-PRIVMSG kinds always return false" do
      for kind <- [:notice, :join, :part, :quit, :nick_change, :mode, :topic, :kick, :server_event] do
        m = msg(kind: kind, body: "vjt: ping")
        # Even with the most aggressive prefs (everything on, mention pattern matches)
        refute notify?(
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

      assert notify?(
               m,
               "vjt",
               prefs(channel_mentions: true),
               []
             )
    end

    test ":action (CTCP /me) passes the kind gate" do
      m = msg(kind: :action, channel: "#sniffo", body: "waves at vjt")

      assert notify?(
               m,
               "vjt",
               prefs(channel_mentions: true),
               []
             )
    end

    test "notifies for EXACTLY Message.notify_kinds/0 — SSOT drift gate (#395)" do
      # The kind gate reads Grappa.Scrollback.Message.notify_kinds/0, NOT a
      # local `[:privmsg, :action]` literal (that literal was the #395 defect:
      # a second, independently-maintained kind list that could silently
      # drift from — or exceed — the unread-content set). With the most
      # permissive channel prefs the kind gate is the ONLY thing that can
      # block a notify, so should_notify? must agree EXACTLY with membership
      # in notify_kinds/0 across the WHOLE schema kind enum. Add a kind to
      # notify_kinds (or let a literal drift from it) → this breaks.
      for kind <- Message.kinds() do
        m = msg(kind: kind, channel: "#sniffo", body: "vjt: ping")
        expected = kind in Message.notify_kinds()

        assert notify?(
                 m,
                 "vjt",
                 prefs(channel_messages_all: true, channel_mentions: true),
                 ["vjt"]
               ) == expected,
               "kind #{inspect(kind)}: should_notify? must match notify_kinds/0 membership (#{expected})"
      end
    end
  end

  describe "should_notify?/5 — DM (channel == own_nick)" do
    test "private_messages_all=true → notify regardless of sender" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")
      assert notify?(m, "vjt", prefs(private_messages_all: true), [])
    end

    test "private_messages_all=false + sender NOT in whitelist → no notify" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      refute notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["bob"]),
               []
             )
    end

    test "private_messages_all=false + sender IN whitelist → notify" do
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      assert notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["alice"]),
               []
             )
    end

    test "whitelist comparison is case-insensitive on sender" do
      m = msg(channel: "vjt", sender: "ALICE", body: "ping")

      assert notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["alice"]),
               []
             )
    end

    test "whitelist match folds sender under ASCII case, not brackets (#525)" do
      # bahamut CASEMAPPING=ascii folds A-Z only, so foo[bar] and FOO[BAR]
      # are the SAME nick (but foo{bar} is DIFFERENT). The stored list is
      # canonicalized to the folded form (UserSettings.normalize_list), so
      # an inbound FOO[BAR] must fold to foo[bar] and match.
      m = msg(channel: "vjt", sender: "FOO[BAR]", body: "ping")

      assert notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["foo[bar]"]),
               []
             )
    end

    test "whitelist match folds sender under ASCII case — tilde kept (#525)" do
      m = msg(channel: "vjt", sender: "FOO~BAZ", body: "ping")

      assert notify?(
               m,
               "vjt",
               prefs(private_messages_all: false, private_messages_only: ["foo~baz"]),
               []
             )
    end

    test "DM does NOT consider channel_messages flags" do
      # A DM with channel_messages_all=true but private_messages_all=false
      # should NOT notify — the DM branch is independent.
      m = msg(channel: "vjt", sender: "alice", body: "ping")

      refute notify?(
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

  describe "should_notify?/5 — channel message" do
    test "channel_messages_all=true → notify regardless of body" do
      m = msg(channel: "#sniffo", body: "no mention here")
      assert notify?(m, "vjt", prefs(channel_messages_all: true), [])
    end

    test "channel_messages_only hit → notify even when _all is off" do
      m = msg(channel: "#sniffo", body: "no mention here")

      assert notify?(
               m,
               "vjt",
               prefs(channel_messages_all: false, channel_messages_only: ["#sniffo"]),
               []
             )
    end

    test "channel_messages_only is case-insensitive on channel name" do
      m = msg(channel: "#SNIFFO", body: "no mention here")

      assert notify?(
               m,
               "vjt",
               prefs(channel_messages_all: false, channel_messages_only: ["#sniffo"]),
               []
             )
    end

    test "channel_mentions=true + body mentions own_nick → notify" do
      m = msg(channel: "#sniffo", body: "vjt: are you there?")
      assert notify?(m, "vjt", prefs(channel_mentions: true), [])
    end

    test "channel_mentions=true + body matches highlight pattern → notify" do
      m = msg(channel: "#sniffo", body: "oncall page incoming")
      assert notify?(m, "vjt", prefs(channel_mentions: true), ["oncall"])
    end

    test "channel_mentions=false → mention does NOT notify" do
      m = msg(channel: "#sniffo", body: "vjt: ping")
      refute notify?(m, "vjt", prefs(channel_mentions: false), [])
    end

    test "all flags off + no whitelist hit + no mention → no notify" do
      m = msg(channel: "#sniffo", body: "no mention")
      refute notify?(m, "vjt", prefs([]), [])
    end

    test "channel mention is word-boundary (substring does NOT match)" do
      m = msg(channel: "#sniffo", body: "vjtbot is paged")
      refute notify?(m, "vjt", prefs(channel_mentions: true), [])
    end
  end

  describe "should_notify?/5 — the subject's OWN rows never notify (#532 C)" do
    test "own OUTBOUND DM matching a highlight pattern does NOT notify" do
      # The #532 C bug: an outbound DM is persisted with `channel = peer`
      # (not own_nick), so the DM branch misses it and it falls to the
      # channel branch, where the user's OWN highlight patterns run over
      # their OWN message body. Excluded by identity: sender == own_nick.
      m = msg(channel: "peer", sender: "vjt", body: "oncall page incoming")

      refute notify?(m, "vjt", prefs(channel_mentions: true), ["oncall"])
    end

    test "own outbound message mentioning own nick does NOT notify" do
      m = msg(channel: "peer", sender: "vjt", body: "note to self: vjt fix this")

      refute notify?(m, "vjt", prefs(channel_mentions: true), [])
    end

    test "own-sender check folds ASCII case — still excluded" do
      # sender differs from own_nick only by ASCII case; the identity fold
      # (#525: ASCII, A-Z only — brackets are NOT folded) must still
      # recognise it as the subject's own row.
      m = msg(channel: "peer", sender: "VJT", body: "oncall")

      refute notify?(m, "vjt", prefs(channel_mentions: true), ["oncall"])
    end

    test "an INBOUND DM from the peer still notifies (regression guard)" do
      # Inbound DM: channel == own_nick, sender == peer. The own-row
      # exclusion must NOT suppress a genuine inbound message.
      m = msg(channel: "vjt", sender: "peer", body: "ping")

      assert notify?(m, "vjt", prefs(private_messages_all: true), [])
    end
  end

  describe "should_notify?/5 — the mute is keyed PER NETWORK (#1038)" do
    # These call the arity-5 predicate directly with two different slugs: the
    # fixed-slug `notify?/4` wrapper the rest of this file uses could not tell
    # a network-blind key from a network-keyed one, which is the entire bug.
    defp muted(key), do: prefs(channel_mentions: true, muted_targets: %{key => %{"until" => nil}})

    test "a mention in the muted channel is silenced on the network it was muted on" do
      m = msg(channel: "#linux", sender: "alice", body: "vjt: ping")

      refute Triggers.should_notify?(m, "azzurra", "vjt", muted("azzurra #linux"), [])
    end

    test "the SAME channel on ANOTHER network still notifies — the #1038 bug" do
      # Pre-#1038 the key was the bare folded channel, so this row matched the
      # mute and returned false. It is the one assertion that fails if the
      # network component is dropped from either the key or the lookup.
      m = msg(channel: "#linux", sender: "alice", body: "vjt: ping")

      assert Triggers.should_notify?(m, "libera", "vjt", muted("azzurra #linux"), [])
    end

    test "a BARE stored key silences nothing, on any network" do
      # What a migration miss (or an old bundle's write, were it not dropped)
      # leaves behind. It must fail OPEN — the conversation notifies — rather
      # than silencing every network, which is the old behaviour.
      m = msg(channel: "#linux", sender: "alice", body: "vjt: ping")

      assert Triggers.should_notify?(m, "azzurra", "vjt", muted("#linux"), [])
      assert Triggers.should_notify?(m, "libera", "vjt", muted("#linux"), [])
    end

    test "the channel half still folds inside the composite" do
      m = msg(channel: "#LiNuX", sender: "alice", body: "vjt: ping")

      refute Triggers.should_notify?(m, "azzurra", "vjt", muted("azzurra #linux"), [])
    end

    test "a DM mutes the PEER on ONE network, not the peer everywhere" do
      # The DM half of #1038: the key is the peer, and the same nick on two
      # networks is two different people.
      m = msg(channel: "vjt", sender: "Alice", body: "ping")
      p = Map.merge(muted("azzurra alice"), %{private_messages_all: true})

      refute Triggers.should_notify?(m, "azzurra", "vjt", p, [])
      assert Triggers.should_notify?(m, "libera", "vjt", p, [])
    end

    test "muting the peer does NOT mute a channel of the same name, and vice versa" do
      # Both halves compose through one `channel_key/2`, so a channel mute and
      # a DM mute on the same network are distinguished only by the sigil the
      # fold leaves in place.
      dm = msg(channel: "vjt", sender: "alice", body: "ping")
      chan = msg(channel: "#alice", sender: "bob", body: "vjt: ping")
      p = Map.merge(muted("azzurra alice"), %{private_messages_all: true})

      refute Triggers.should_notify?(dm, "azzurra", "vjt", p, [])
      assert Triggers.should_notify?(chan, "azzurra", "vjt", p, [])
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
    # #211 phase 7 — provision binds an anon credential, so the network
    # must exist first.
    {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: "libera"})
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
