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
      `Push.Sender.send_to_user/2`. Tested end-to-end via Bypass +
      real `push_subscriptions` rows + `:telemetry` to observe the
      `[:grappa, :push, :send, :start | :stop]` events.

  The `should_notify?/4` test class is `async: true` (no DB).
  The `evaluate_and_dispatch/2` test class is `async: false`
  (DataCase + Bypass).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Push, UserSettings}
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

  defp subscription_fixture(user, endpoint) do
    {:ok, sub} =
      Push.create(user, %{
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

    test "matching PRIVMSG → Sender.send_to_user fires (telemetry observed)", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :send, :start], [:grappa, :push, :send, :stop]])

      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      user = user_fixture()
      _ = subscription_fixture(user, endpoint)

      # Default prefs have channel_mentions: true, so a body mentioning
      # "vjt" on a channel triggers notify.
      m = msg(channel: "#sniffo", sender: "alice", body: "vjt: ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 user_id: user.id,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      uid = user.id
      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{user_id: ^uid}}, 2_000
      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{user_id: ^uid}}, 2_000
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
      _ = subscription_fixture(user, endpoint)

      # No mention, no whitelist, _all flags default off for channel.
      m = msg(channel: "#sniffo", sender: "alice", body: "no mention here")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 user_id: user.id,
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
      _ = subscription_fixture(user, endpoint)

      m = msg(kind: :join, channel: "#sniffo", sender: "alice", body: nil)

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 user_id: user.id,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "user with no subscriptions → match still safe (Sender no-op)", %{
      bypass: _bypass,
      endpoint: _endpoint
    } do
      # Sender.send_to_user/2 short-circuits on empty subs list and
      # emits no telemetry — verify the dispatcher tolerates that.
      attach_telemetry([[:grappa, :push, :send, :start]])

      user = user_fixture()
      # No subscription_fixture/2 call.

      m = msg(channel: "vjt", sender: "alice", body: "ping")

      assert :ok =
               Triggers.evaluate_and_dispatch(m, %{
                 user_id: user.id,
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
      _ = subscription_fixture(user, endpoint)

      # Override defaults: channel_mentions OFF
      {:ok, _} =
        UserSettings.put_notification_prefs(user.id, %{
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
                 user_id: user.id,
                 network_slug: "libera",
                 own_nick: "vjt"
               })

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 300
    end

    test "Sender.send_to_user persists last_used_at on success", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.expect(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)
      attach_telemetry([[:grappa, :push, :send, :stop]])

      user = user_fixture()
      sub = subscription_fixture(user, endpoint)
      assert is_nil(sub.last_used_at)

      m = msg(channel: "vjt", sender: "alice", body: "ping")

      :ok =
        Triggers.evaluate_and_dispatch(m, %{
          user_id: user.id,
          network_slug: "libera",
          own_nick: "vjt"
        })

      uid = user.id
      assert_receive {:telemetry, [:grappa, :push, :send, :stop], _, %{user_id: ^uid}}, 2_000

      reloaded = Repo.get!(Subscription, sub.id)
      refute is_nil(reloaded.last_used_at)
    end
  end
end
