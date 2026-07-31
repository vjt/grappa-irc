defmodule Grappa.WindowCountsTest do
  @moduledoc """
  Server-authoritative per-window unread/mention/severity snapshot
  (#267). `snapshot/6` derives `%{messages, mentions, events,
  severity}` for a `(subject, network, channel)` window from the read
  cursor + the messages table — no persisted counter, no client
  compute.

  Coverage: the content/presence split (messages vs events, #265),
  the mention subset (`Mentions.mentioned?/3` SSOT via own_nick +
  highlight patterns), own-sender exclusion (you cannot mention
  yourself), the severity ladder (mention > message > event > none),
  nil-cursor (count from 0), past-tail (all zero), and the mention
  scan cap.

  `async: true` — every test mints fresh rows; `snapshot/6` is a pure
  read over sandboxed Repo state.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{AuthFixtures, ReadCursor, ScrollbackHelpers, WindowCounts}

  defp uniq, do: System.unique_integer([:positive])

  defp ctx do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()
    %{subject: {:user, user.id}, network: network}
  end

  # #396 — insert into an explicit network (multi-network bulk tests).
  defp ins(subject, network_id, channel, opts) do
    attrs =
      reject_nil(%{
        user_id: elem(subject, 1),
        network_id: network_id,
        channel: channel,
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: Keyword.get(opts, :body, "hello"),
        dm_with: opts[:dm_with],
        meta: opts[:meta]
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  # Sets the read cursor for a window (validated against a real row).
  defp cursor(subject, network_id, channel, message_id) do
    {:ok, _} = ReadCursor.set(subject, network_id, channel, message_id)
    :ok
  end

  # Inserts one row, returns the persisted `%Message{}`.
  defp insert(ctx, channel, opts) do
    attrs =
      reject_nil(%{
        user_id: elem(ctx.subject, 1),
        network_id: ctx.network.id,
        channel: channel,
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: Keyword.get(opts, :body, "hello"),
        dm_with: opts[:dm_with],
        meta: opts[:meta]
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  defp reject_nil(map), do: :maps.filter(fn _, v -> v != nil end, map)

  # snapshot with no highlight patterns unless overridden.
  defp snap(ctx, channel, cursor, own_nick, patterns \\ []) do
    WindowCounts.snapshot(ctx.subject, ctx.network.id, channel, cursor, own_nick, patterns)
  end

  # ---------------------------------------------------------------------------
  # Empty / past-tail
  # ---------------------------------------------------------------------------

  test "empty window returns all-zero, severity :none" do
    c = ctx()
    assert snap(c, "#chan", 0, "vjt") == %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  test "zero/0 is the all-zero none snapshot" do
    assert WindowCounts.zero() == %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  test "cursor at the tail returns all-zero, severity :none" do
    c = ctx()
    insert(c, "#chan", st: 1, body: "a")
    last = insert(c, "#chan", st: 2, body: "b")

    assert snap(c, "#chan", last.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  # ---------------------------------------------------------------------------
  # messages vs events split (#265)
  # ---------------------------------------------------------------------------

  test "content messages count under :messages, severity :message" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "one")
    insert(c, "#chan", st: 3, sender: "bob", body: "two")

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 2, mentions: 0, events: 0, severity: :message}
  end

  test "presence/control events count under :events only, severity :event" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "bob", kind: :join, body: nil)
    insert(c, "#chan", st: 3, sender: "bob", kind: :part, body: nil)
    insert(c, "#chan", st: 4, sender: "bob", kind: :mode, body: nil)

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 3, severity: :event}
  end

  test "the subject's OWN self-PART is NOT counted as an unread event (#532 A)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # Own self-PART (leaving the channel) — the exact #532 A shape.
    insert(c, "#chan", st: 2, sender: "vjt", kind: :part, body: nil)
    # Another user's presence event must still count.
    insert(c, "#chan", st: 3, sender: "bob", kind: :join, body: nil)

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 1, severity: :event}
  end

  test "a self-PART that is the only unread leaves nothing pending (#532 A)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "vjt", kind: :part, body: nil)

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  test "own-presence exclusion preserves unread CONTENT before the leave (#532 A/B)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # A real mention arrives, then the operator parts without reading it.
    insert(c, "#chan", st: 2, sender: "bob", body: "hey vjt")
    insert(c, "#chan", st: 3, sender: "vjt", kind: :part, body: nil)

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 1
    assert result.events == 0
    assert result.mentions == 1
    assert result.severity == :mention
  end

  test "self-KICK and a genuine self-rename are excluded — general own-presence rule (#532 A)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # A KICK the subject issued: sender is their live nick.
    insert(c, "#chan", st: 2, sender: "vjt", kind: :kick, body: nil)
    # A genuine self-rename is persisted with `sender = OLD nick` and
    # `meta.new_nick = NEW` (EventRouter fan-out); the live nick is NEW, so
    # only the meta.new_nick clause catches it. sender != own_nick here — a
    # rename to the SAME nick is impossible, so this is the realistic shape.
    insert(c, "#chan", st: 3, sender: "oldvjt", kind: :nick_change, body: nil, meta: %{new_nick: "vjt"})

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  test "a PEER's rename still counts as an event (own-presence exclusion is scoped)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # bob renames to carol — neither the old sender nor the new nick is the
    # subject's live nick, so it is a legitimate unread event.
    insert(c, "#chan", st: 2, sender: "bob", kind: :nick_change, body: nil, meta: %{new_nick: "carol"})

    assert snap(c, "#chan", anchor.id, "vjt").events == 1
  end

  test "join/part churn alone never escalates above :event (#265)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    for i <- 2..10, do: insert(c, "#chan", st: i, sender: "bob", kind: :join, body: nil)

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 0
    assert result.severity == :event
  end

  # ---------------------------------------------------------------------------
  # mention subset — Mentions.mentioned?/3 SSOT
  # ---------------------------------------------------------------------------

  test "nick mention at word boundary counts under :mentions, severity :mention" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "morning all")
    insert(c, "#chan", st: 3, sender: "bob", body: "hey vjt ping")
    insert(c, "#chan", st: 4, sender: "dave", body: "vjt: around?")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 3
    assert result.mentions == 2
    assert result.severity == :mention
  end

  test "substring is not a mention (word-boundary)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "vjt123 is a different nick")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 1
    assert result.mentions == 0
    assert result.severity == :message
  end

  test "highlight patterns also produce mentions, not just own_nick" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "i love grappa")
    insert(c, "#chan", st: 3, sender: "bob", body: "ping vjt")
    insert(c, "#chan", st: 4, sender: "carol", body: "unrelated")

    result = snap(c, "#chan", anchor.id, "vjt", ["grappa"])
    assert result.messages == 3
    assert result.mentions == 2
    assert result.severity == :mention
  end

  test "own-sent message naming own nick is NOT a self-mention" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # Own message that happens to contain own nick (e.g. quoting).
    insert(c, "#chan", st: 2, sender: "vjt", body: "as vjt i say hi")
    # A real mention from someone else.
    insert(c, "#chan", st: 3, sender: "bob", body: "vjt you there")

    result = snap(c, "#chan", anchor.id, "vjt")
    # #576 — the own message is read BY DEFINITION and no longer counts; only
    # bob's peer line does. mentions were already own-excluded (an own line
    # naming own nick is not a self-mention), so this test's point stands.
    assert result.messages == 1
    assert result.mentions == 1
    assert result.severity == :mention
  end

  test "own-sender fold respects ASCII casemapping (#525)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # own_nick "foo[bar]"; own-sent under the case-variant "FOO[BAR]"
    # (ASCII fold-equal — brackets are NOT folded post-#525).
    insert(c, "#chan", st: 2, sender: "FOO[BAR]", body: "foo[bar] wrote this")

    result = snap(c, "#chan", anchor.id, "foo[bar]")
    assert result.mentions == 0
  end

  # ---------------------------------------------------------------------------
  # severity ladder
  # ---------------------------------------------------------------------------

  test "mention outranks message and event in a mixed window" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "plain msg")
    insert(c, "#chan", st: 3, sender: "bob", kind: :join, body: nil)
    insert(c, "#chan", st: 4, sender: "carol", body: "vjt ping")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result == %{messages: 2, mentions: 1, events: 1, severity: :mention}
  end

  # ---------------------------------------------------------------------------
  # nil cursor — count from 0
  # ---------------------------------------------------------------------------

  test "nil cursor counts every row from the beginning" do
    c = ctx()
    insert(c, "#chan", st: 1, sender: "alice", body: "a")
    insert(c, "#chan", st: 2, sender: "bob", body: "vjt hi")

    result = snap(c, "#chan", nil, "vjt")
    assert result.messages == 2
    assert result.mentions == 1
    assert result.severity == :mention
  end

  # ---------------------------------------------------------------------------
  # nil own_nick — unbound network with no configured nick (/me door)
  # ---------------------------------------------------------------------------

  test "nil own_nick yields zero mentions but still counts messages/events" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # Would be a mention if we knew the nick — but with no configured nick
    # on an unbound-but-retained network there is nothing to match.
    insert(c, "#chan", st: 2, sender: "bob", body: "vjt ping")
    insert(c, "#chan", st: 3, sender: "carol", kind: :join, body: nil)

    result = WindowCounts.snapshot(c.subject, c.network.id, "#chan", anchor.id, nil, [])
    assert result == %{messages: 1, mentions: 0, events: 1, severity: :message}
  end

  # ---------------------------------------------------------------------------
  # #396 — bulk_snapshot/3: the WHOLE subject's envelope in a CONSTANT number
  # of queries. Identical to the per-window snapshot/6 loop for channel + DM
  # windows; the own-nick SELF window count changes BY DESIGN (single COALESCE
  # predicate — see the two self-DM tests below + DESIGN_NOTES 2026-07-25).
  # ---------------------------------------------------------------------------
  describe "bulk_snapshot/3 (#396 constant-query cold-load)" do
    test "matches per-window snapshot/6 for channel + DM windows across networks" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net_a = AuthFixtures.network_fixture()
      net_b = AuthFixtures.network_fixture()
      own = "vjt"

      # net_a #chan: anchor + 2 content (1 nick mention) + 1 presence event.
      a = ins(subject, net_a.id, "#chan", st: 1, body: "anchor")
      ins(subject, net_a.id, "#chan", st: 2, sender: "alice", body: "hi vjt")
      ins(subject, net_a.id, "#chan", st: 3, sender: "bob", body: "plain")
      ins(subject, net_a.id, "#chan", st: 4, sender: "bob", kind: :join, body: nil)
      cursor(subject, net_a.id, "#chan", a.id)

      # net_a DM peer window: inbound (channel=own, dm_with=peer) + outbound.
      di = ins(subject, net_a.id, own, st: 5, sender: "peer", body: "vjt yo", dm_with: "peer")
      ins(subject, net_a.id, "peer", st: 6, sender: own, body: "re", dm_with: "peer")
      cursor(subject, net_a.id, "peer", di.id)

      # net_b #ops: anchor + 1 content, distinct network in the same call.
      b = ins(subject, net_b.id, "#ops", st: 1, body: "anchor-b")
      ins(subject, net_b.id, "#ops", st: 2, sender: "carol", body: "ping")
      cursor(subject, net_b.id, "#ops", b.id)

      own_nicks = %{net_a.slug => {net_a.id, own}, net_b.slug => {net_b.id, own}}
      bulk = WindowCounts.bulk_snapshot(subject, own_nicks, [])

      assert bulk[net_a.slug]["#chan"] ==
               WindowCounts.snapshot(subject, net_a.id, "#chan", a.id, own, [])

      assert bulk[net_a.slug]["peer"] ==
               WindowCounts.snapshot(subject, net_a.id, "peer", di.id, own, [])

      assert bulk[net_b.slug]["#ops"] ==
               WindowCounts.snapshot(subject, net_b.id, "#ops", b.id, own, [])
    end

    test "highlight patterns fold through the bulk mention path too" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net = AuthFixtures.network_fixture()
      own = "vjt"

      a = ins(subject, net.id, "#chan", st: 1, body: "anchor")
      ins(subject, net.id, "#chan", st: 2, sender: "alice", body: "i love grappa")
      ins(subject, net.id, "#chan", st: 3, sender: "bob", body: "unrelated")
      cursor(subject, net.id, "#chan", a.id)

      bulk = WindowCounts.bulk_snapshot(subject, %{net.slug => {net.id, own}}, ["grappa"])

      assert bulk[net.slug]["#chan"] ==
               WindowCounts.snapshot(subject, net.id, "#chan", a.id, own, ["grappa"])

      assert bulk[net.slug]["#chan"].mentions == 1
    end

    # #576 self-window carve-out: the own-nick window is the ONE window where
    # own content is legitimate payload (a note-to-self), so #576 does NOT
    # exclude it there — #396's counts stand unchanged. (Own content IS
    # excluded in peer / channel windows; see the #576 tests in
    # scrollback_test / read_cursor_test and "own-sent message …" above.)
    test "own-nick self window: legacy (channel=own, dm_with NULL) rows now COUNT (#396)" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net = AuthFixtures.network_fixture()
      own = "vjt"

      anchor = ins(subject, net.id, own, st: 1, sender: own, body: "self anchor", dm_with: own)
      cursor(subject, net.id, own, anchor.id)
      # A legacy inbound row (pre-CP14-B3) / server notice routed to the own
      # window: channel=own, dm_with NULL. The old narrowing excluded it.
      ins(subject, net.id, own, st: 2, sender: "someone", body: "legacy line", dm_with: nil)
      # A genuine self-message.
      ins(subject, net.id, own, st: 3, sender: own, body: "to self", dm_with: own)

      bulk = WindowCounts.bulk_snapshot(subject, %{net.slug => {net.id, own}}, [])

      # #396: COALESCE(dm_with, channel) folds the NULL row's channel=own in.
      assert bulk[net.slug][own].messages == 2

      # Explicit behaviour delta: the OLD per-window narrowing
      # (`channel == own AND dm_with == own`) MISSES the dm_with-NULL row.
      assert WindowCounts.snapshot(subject, net.id, own, anchor.id, own, []).messages == 1
    end

    test "own-nick self window: mixed-case self-msg COUNTS via fold (#396)" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net = AuthFixtures.network_fixture()
      own = "vjt"

      anchor = ins(subject, net.id, own, st: 1, sender: own, body: "anchor", dm_with: own)
      cursor(subject, net.id, own, anchor.id)
      # Self-message whose dm_with is stored at a differing (ASCII-equivalent)
      # casing — display-preserved, so the fold is required to match.
      ins(subject, net.id, own, st: 2, sender: own, body: "cased self", dm_with: "VJT")

      bulk = WindowCounts.bulk_snapshot(subject, %{net.slug => {net.id, own}}, [])

      # #396: both sides fold → "VJT" resolves to the own window.
      assert bulk[net.slug][own].messages == 1

      # #537/#372 reversed assert (was `== 0`): the own-nick self-window
      # narrowing in `Scrollback.channel_or_dm_where/3` now folds `dm_with`
      # via `nick_fold/1` (dm_with is stored RAW for display, so the MATCH
      # must fold — the #121/#372 nick invariant), so `snapshot/6` counts the
      # cased self-msg exactly like `bulk_snapshot/3` does. The pre-fold RAW
      # compare (`"VJT" != "vjt"` → 0) was the bug this line of work closes.
      assert WindowCounts.snapshot(subject, net.id, own, anchor.id, own, []).messages == 1
    end

    test "nil own_nick (unbound network) yields mentions 0 but counts messages/events" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net = AuthFixtures.network_fixture()

      anchor = ins(subject, net.id, "#chan", st: 1, body: "anchor")
      cursor(subject, net.id, "#chan", anchor.id)
      # Would be a mention if a nick were known — but no configured nick here.
      ins(subject, net.id, "#chan", st: 2, sender: "bob", body: "vjt ping")
      ins(subject, net.id, "#chan", st: 3, sender: "bob", kind: :join, body: nil)

      # own_nicks WITHOUT this slug → own_nick_for_slug resolves nil.
      bulk = WindowCounts.bulk_snapshot(subject, %{}, [])

      assert bulk[net.slug]["#chan"] ==
               %{messages: 1, mentions: 0, events: 1, severity: :message}
    end

    test "a window read to the tail is present with all-zero counts (LEFT JOIN)" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}
      net = AuthFixtures.network_fixture()
      own = "vjt"

      m = ins(subject, net.id, "#chan", st: 1, body: "only")
      cursor(subject, net.id, "#chan", m.id)

      bulk = WindowCounts.bulk_snapshot(subject, %{net.slug => {net.id, own}}, [])

      assert bulk[net.slug]["#chan"] ==
               %{messages: 0, mentions: 0, events: 0, severity: :none}
    end

    test "a subject with no cursors yields an empty envelope" do
      user = AuthFixtures.user_fixture()
      subject = {:user, user.id}

      assert WindowCounts.bulk_snapshot(subject, %{}, []) == %{}
    end

    test "issues a CONSTANT number of queries (2) regardless of window count" do
      # The whole point of #396: the cold-load fan-out (2 queries PER window,
      # ~2N) collapses to 2 total. Prove it with a query counter, at 3 and 30
      # windows — the count must not scale with N.
      subject_3 = seed_windows(3)
      subject_30 = seed_windows(30)

      q3 = count_repo_queries(fn -> WindowCounts.bulk_snapshot(subject_3, %{}, []) end)
      q30 = count_repo_queries(fn -> WindowCounts.bulk_snapshot(subject_30, %{}, []) end)

      assert q3 == 2, "expected exactly 2 queries for 3 windows, got #{q3}"
      assert q30 == 2, "expected exactly 2 queries for 30 windows, got #{q30}"
      # Sanity: the 30-window subject really has 30 windows in the envelope.
      assert map_size(hd(Map.values(WindowCounts.bulk_snapshot(subject_30, %{}, [])))) == 30
    end
  end

  # Seeds `n` channel windows (each: anchor + 1 unread) for a fresh subject on
  # one network; returns the subject. Slug is single so the envelope nests
  # under one network key.
  defp seed_windows(n) do
    user = AuthFixtures.user_fixture()
    subject = {:user, user.id}
    net = AuthFixtures.network_fixture()

    for i <- 1..n do
      a = ins(subject, net.id, "#c#{i}", st: 1, body: "anchor")
      ins(subject, net.id, "#c#{i}", st: 2, sender: "bob", body: "unread")
      cursor(subject, net.id, "#c#{i}", a.id)
    end

    subject
  end

  # Counts `[:grappa, :repo, :query]` telemetry events emitted while `fun`
  # runs (Ecto emits one per statement, synchronously in the caller process).
  defp count_repo_queries(fun) do
    ref = make_ref()
    test_pid = self()

    :telemetry.attach(
      {__MODULE__, ref},
      [:grappa, :repo, :query],
      fn _, _, _, _ -> send(test_pid, {ref, :q}) end,
      nil
    )

    try do
      fun.()
    after
      :telemetry.detach({__MODULE__, ref})
    end

    drain_query_count(ref, 0)
  end

  defp drain_query_count(ref, acc) do
    receive do
      {^ref, :q} -> drain_query_count(ref, acc + 1)
    after
      0 -> acc
    end
  end
end
