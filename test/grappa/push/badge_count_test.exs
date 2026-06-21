defmodule Grappa.Push.BadgeCountTest do
  @moduledoc """
  PWA icon-badge count (2026-06-21). `count/1` returns the number of
  unread scrollback rows that pass the REAL push predicate
  `Grappa.Push.Triggers.should_notify?/4`, capped at 99.

  Coverage mirrors the design's test list: every prefs branch (DM
  all / whitelist / off, channel all / whitelist, mention via nick /
  pattern), events never count, per-channel + global 99 caps, stale
  cursor skipping, and the visitor subject path.

  `async: true` — every test mints fresh user / network / visitor rows;
  the count is a pure read with no shared singleton.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{AuthFixtures, ReadCursor, ScrollbackHelpers, UserSettings}
  alias Grappa.Push.BadgeCount

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  defp uniq, do: System.unique_integer([:positive])

  # User + network + credential bound with `nick` so the off-Session
  # own_nick resolution (`Networks.configured_nick_index/1`) has a row.
  defp user_ctx(nick \\ "vjt") do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()
    _ = AuthFixtures.credential_fixture(user, network, %{nick: nick})
    %{subject: {:user, user.id}, user: user, network: network, own_nick: nick}
  end

  # Inserts one content row, returns the persisted `%Message{}`.
  defp insert(ctx, channel, opts) do
    attrs =
      reject_nil(%{
        user_id: subject_id(ctx.subject),
        network_id: ctx.network.id,
        channel: channel,
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: opts[:body] || "hello",
        dm_with: opts[:dm_with]
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  # Visitor variant — visitor rows carry `visitor_id`, not `user_id`.
  defp insert_visitor(visitor, network, channel, opts) do
    attrs =
      reject_nil(%{
        visitor_id: visitor.id,
        network_id: network.id,
        channel: channel,
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: opts[:body] || "hello",
        dm_with: opts[:dm_with]
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  defp reject_nil(map), do: :maps.filter(fn _, v -> v != nil end, map)

  defp subject_id({_, id}), do: id

  # Seeds a cursor for `(subject, network, channel)` at `message_id`.
  defp set_cursor(subject, network, channel, message_id) do
    {:ok, _} = ReadCursor.set(subject, network.id, channel, message_id)
    :ok
  end

  defp set_prefs(subject, overrides) do
    prefs = Map.merge(UserSettings.default_notification_prefs(), Map.new(overrides))
    {:ok, _} = UserSettings.put_notification_prefs(subject, prefs)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Empty / no-cursor
  # ---------------------------------------------------------------------------

  test "returns 0 when the subject has no read cursors" do
    ctx = user_ctx()
    assert BadgeCount.count(ctx.subject) == 0
  end

  test "returns 0 when there are unread rows but no cursor on their window" do
    ctx = user_ctx()
    # Messages exist but no cursor was ever set — `/me`-parity: channels
    # without a cursor are not counted (cic falls back to the join seed).
    insert(ctx, "#chan", body: "hey vjt")
    assert BadgeCount.count(ctx.subject) == 0
  end

  # ---------------------------------------------------------------------------
  # DM branch
  # ---------------------------------------------------------------------------

  test "DM-all counts unread inbound DMs in the peer window" do
    ctx = user_ctx("vjt")
    set_prefs(ctx.subject, private_messages_all: true)

    # Inbound DM rows: channel = own_nick, dm_with = peer, sender = peer.
    dm1 = insert(ctx, "vjt", st: 1, sender: "alice", dm_with: "alice", body: "yo")
    insert(ctx, "vjt", st: 2, sender: "alice", dm_with: "alice", body: "ping")
    insert(ctx, "vjt", st: 3, sender: "alice", dm_with: "alice", body: "still there?")

    set_cursor(ctx.subject, ctx.network, "alice", dm1.id)

    assert BadgeCount.count(ctx.subject) == 2
  end

  test "DM-whitelist counts only whitelisted senders; other peers excluded" do
    ctx = user_ctx("vjt")
    set_prefs(ctx.subject, private_messages_all: false, private_messages_only: ["alice"])

    a1 = insert(ctx, "vjt", st: 1, sender: "alice", dm_with: "alice", body: "1")
    insert(ctx, "vjt", st: 2, sender: "alice", dm_with: "alice", body: "2")
    b1 = insert(ctx, "vjt", st: 3, sender: "bob", dm_with: "bob", body: "hi")
    insert(ctx, "vjt", st: 4, sender: "bob", dm_with: "bob", body: "yo")

    set_cursor(ctx.subject, ctx.network, "alice", a1.id)
    set_cursor(ctx.subject, ctx.network, "bob", b1.id)

    # alice window: 1 unread + whitelisted. bob window: 1 unread, NOT
    # whitelisted → 0.
    assert BadgeCount.count(ctx.subject) == 1
  end

  test "DM prefs fully off → 0 even with unread DMs" do
    ctx = user_ctx("vjt")
    set_prefs(ctx.subject, private_messages_all: false, private_messages_only: [])

    d1 = insert(ctx, "vjt", st: 1, sender: "alice", dm_with: "alice", body: "1")
    insert(ctx, "vjt", st: 2, sender: "alice", dm_with: "alice", body: "2")
    set_cursor(ctx.subject, ctx.network, "alice", d1.id)

    assert BadgeCount.count(ctx.subject) == 0
  end

  # ---------------------------------------------------------------------------
  # Channel branch
  # ---------------------------------------------------------------------------

  test "channel-all counts every unread content row in the channel" do
    ctx = user_ctx()
    set_prefs(ctx.subject, channel_messages_all: true)

    c1 = insert(ctx, "#chan", st: 1, sender: "alice", body: "a")
    insert(ctx, "#chan", st: 2, sender: "bob", body: "b")
    insert(ctx, "#chan", st: 3, sender: "carol", body: "c")
    set_cursor(ctx.subject, ctx.network, "#chan", c1.id)

    assert BadgeCount.count(ctx.subject) == 2
  end

  test "channel-whitelist counts the listed channel, not unlisted ones" do
    ctx = user_ctx()

    set_prefs(ctx.subject,
      channel_messages_all: false,
      channel_messages_only: ["#chan"],
      channel_mentions: false
    )

    c1 = insert(ctx, "#chan", st: 1, sender: "alice", body: "a")
    insert(ctx, "#chan", st: 2, sender: "bob", body: "b")
    o1 = insert(ctx, "#other", st: 3, sender: "carol", body: "c")
    insert(ctx, "#other", st: 4, sender: "dave", body: "d")

    set_cursor(ctx.subject, ctx.network, "#chan", c1.id)
    set_cursor(ctx.subject, ctx.network, "#other", o1.id)

    # #chan: 1 unread + whitelisted. #other: 1 unread, not whitelisted,
    # mentions off → 0.
    assert BadgeCount.count(ctx.subject) == 1
  end

  # ---------------------------------------------------------------------------
  # Mention branch — reuses the REAL Mentions.mentioned?/3 via should_notify?
  # ---------------------------------------------------------------------------

  test "mention branch counts nick mentions, ignores non-mentions (default prefs)" do
    # Default prefs: channel_mentions true, channel_messages_all false.
    ctx = user_ctx("vjt")

    c1 = insert(ctx, "#chan", st: 1, sender: "alice", body: "morning all")
    insert(ctx, "#chan", st: 2, sender: "bob", body: "hey vjt ping")
    insert(ctx, "#chan", st: 3, sender: "carol", body: "nothing here")
    insert(ctx, "#chan", st: 4, sender: "dave", body: "vjt: you around?")
    set_cursor(ctx.subject, ctx.network, "#chan", c1.id)

    # Two of the three unread rows name vjt at a word boundary.
    assert BadgeCount.count(ctx.subject) == 2
  end

  test "mention branch also matches highlight patterns, not just own_nick" do
    ctx = user_ctx("vjt")
    {:ok, _} = UserSettings.set_highlight_patterns(ctx.subject, ["grappa"])

    c1 = insert(ctx, "#chan", st: 1, sender: "alice", body: "kickoff")
    insert(ctx, "#chan", st: 2, sender: "bob", body: "i love grappa")
    insert(ctx, "#chan", st: 3, sender: "carol", body: "ping vjt")
    insert(ctx, "#chan", st: 4, sender: "dave", body: "unrelated")
    set_cursor(ctx.subject, ctx.network, "#chan", c1.id)

    # "grappa" pattern + "vjt" nick → 2.
    assert BadgeCount.count(ctx.subject) == 2
  end

  # ---------------------------------------------------------------------------
  # Kind gate — events never count
  # ---------------------------------------------------------------------------

  test "presence/control events never count even with channel-all" do
    ctx = user_ctx()
    set_prefs(ctx.subject, channel_messages_all: true)

    anchor = insert(ctx, "#chan", st: 1, sender: "zed", body: "anchor")
    # One real content row + two body-less presence rows, all after the
    # cursor.
    insert(ctx, "#chan", st: 2, sender: "alice", body: "real message")
    insert(ctx, "#chan", st: 3, sender: "bob", kind: :join, body: nil)
    insert(ctx, "#chan", st: 4, sender: "bob", kind: :part, body: nil)
    set_cursor(ctx.subject, ctx.network, "#chan", anchor.id)

    # Only the privmsg counts; join/part are dropped at the content-kind
    # SQL filter in `unread_content_tail/6`.
    assert BadgeCount.count(ctx.subject) == 1
  end

  # ---------------------------------------------------------------------------
  # Caps
  # ---------------------------------------------------------------------------

  test "caps at 99 with a flood of unread mentions" do
    ctx = user_ctx("vjt")
    set_prefs(ctx.subject, channel_messages_all: true)

    first = insert(ctx, "#flood", st: 0, sender: "alice", body: "anchor")

    for i <- 1..250 do
      insert(ctx, "#flood", st: i, sender: "alice", body: "msg #{i}")
    end

    set_cursor(ctx.subject, ctx.network, "#flood", first.id)

    count = BadgeCount.count(ctx.subject)
    assert count == 99
    assert count <= 99
  end

  # ---------------------------------------------------------------------------
  # Stale cursor — slug no longer resolvable
  # ---------------------------------------------------------------------------

  test "cursor on a network the user has no credential on is skipped" do
    ctx = user_ctx()
    set_prefs(ctx.subject, channel_messages_all: true)

    # A second network with messages + cursor but NO credential bound —
    # configured_nick_index won't carry its slug, so the fold drops it.
    other_net = AuthFixtures.network_fixture()

    {:ok, m1} =
      ScrollbackHelpers.insert(%{
        user_id: subject_id(ctx.subject),
        network_id: other_net.id,
        channel: "#orphan",
        server_time: 1,
        kind: :privmsg,
        sender: "alice",
        body: "a"
      })

    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: subject_id(ctx.subject),
        network_id: other_net.id,
        channel: "#orphan",
        server_time: 2,
        kind: :privmsg,
        sender: "bob",
        body: "b"
      })

    {:ok, _} = ReadCursor.set(ctx.subject, other_net.id, "#orphan", m1.id)

    assert BadgeCount.count(ctx.subject) == 0
  end

  # ---------------------------------------------------------------------------
  # Visitor subject
  # ---------------------------------------------------------------------------

  test "visitor subject counts via visitor.nick (off-Session)" do
    network = AuthFixtures.network_fixture()

    {:ok, visitor} =
      Grappa.Visitors.find_or_provision_anon("ann-#{uniq()}", network.slug, "127.0.0.1")

    subject = {:visitor, visitor.id}
    set_prefs(subject, channel_messages_all: false, channel_mentions: true)

    c1 = insert_visitor(visitor, network, "#chan", st: 1, sender: "alice", body: "hi")

    insert_visitor(visitor, network, "#chan",
      st: 2,
      sender: "bob",
      body: "yo #{visitor.nick} ping"
    )

    insert_visitor(visitor, network, "#chan", st: 3, sender: "carol", body: "noise")
    set_cursor(subject, network, "#chan", c1.id)

    assert BadgeCount.count(subject) == 1
  end
end
