defmodule Grappa.ReadCursorTest do
  @moduledoc """
  Context tests for `Grappa.ReadCursor` — server-owned per-(subject,
  network, channel) read cursor.

  Coverage:

    * `get/3` returns nil when no cursor exists, the row when it does.
    * `set/4` insert path (no prior cursor).
    * `set/4` monotonic advance: same-id no-ops, lower-id is a no-op
      (cursor stays at the higher id, #233), higher-id moves forward.
    * `set/4` rejects `:invalid_message` when the message_id doesn't
      belong to (subject, network, channel) — wrong network, wrong
      channel, wrong subject, or absent row.
    * `set/4` honors subject XOR via the changeset.
    * `bulk_for_subject/1` returns the nested envelope shape.
    * `broadcast_set/5` emits a typed `read_cursor_set` payload (with
      the door-#3 `badge_count`) on the
      per-channel topic.

  `async: true` — every test creates fresh user/network/visitor rows;
  the broadcast test subscribes to a per-user topic so distinct
  user_names eliminate crosstalk.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Networks, ReadCursor, Repo, ScrollbackHelpers, Visitors}
  alias Grappa.PubSub.Topic
  alias Grappa.ReadCursor.Cursor

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  defp uniq, do: System.unique_integer([:positive])

  defp user_fixture do
    {:ok, user} =
      Accounts.create_user(%{name: "rc-user-#{uniq()}", password: "correct horse battery staple"})

    user
  end

  defp visitor_fixture(network_slug) do
    {:ok, visitor} =
      Visitors.find_or_provision_anon("rc-visitor-#{uniq()}", network_slug, "127.0.0.1")

    visitor
  end

  defp network_fixture do
    {:ok, network} = Networks.find_or_create_network(%{slug: "rc-net-#{uniq()}"})
    network
  end

  # Generic unread-content inserter: `sender: "peer"` so a row stands for
  # someone ELSE's message. #576 excludes the subject's OWN content from the
  # unread count, and every `bulk_unread_split/3` test here threads
  # `own_nicks` as "vjt" — a "vjt" sender would fold to own and drop out,
  # silently zeroing the very counts these tests assert. Own-authored rows
  # are inserted explicitly (see the #532 A / #576 tests).
  defp insert_message(subject_attrs, network_id, channel, server_time, body \\ "msg") do
    attrs =
      Map.merge(subject_attrs, %{
        network_id: network_id,
        channel: channel,
        server_time: server_time,
        kind: :privmsg,
        sender: "peer",
        body: body
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  # ---------------------------------------------------------------------------
  # get/3
  # ---------------------------------------------------------------------------

  describe "get/3" do
    test "returns nil when no cursor exists" do
      user = user_fixture()
      net = network_fixture()

      assert nil == ReadCursor.get({:user, user.id}, net.id, "#sniffo")
    end

    test "returns the cursor row after a set" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#sniffo", 1)

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#sniffo", msg.id)

      assert %Cursor{} = cursor = ReadCursor.get({:user, user.id}, net.id, "#sniffo")
      assert cursor.last_read_message_id == msg.id
      assert cursor.user_id == user.id
      assert cursor.visitor_id == nil
      assert cursor.network_id == net.id
      assert cursor.channel == "#sniffo"
    end

    test "isolates by (subject, network, channel) — does not leak across rows" do
      alice = user_fixture()
      bob = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: alice.id}, net.id, "#sniffo", 1)

      {:ok, _} = ReadCursor.set({:user, alice.id}, net.id, "#sniffo", msg.id)

      assert nil == ReadCursor.get({:user, bob.id}, net.id, "#sniffo")
    end
  end

  # ---------------------------------------------------------------------------
  # DM-window nick fold — one window ⇒ one cursor row (#532 D)
  # ---------------------------------------------------------------------------

  describe "set/4 + get/3 — DM peer key folds shape-appropriately (#532 D)" do
    test "two casings of a DM peer resolve to ONE cursor row and advance it" do
      user = user_fixture()
      net = network_fixture()
      # Outbound DM rows in the peer window (channel = peer, dm_with nil).
      m1 = insert_message(%{user_id: user.id}, net.id, "NickTemp", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "NickTemp", 2)

      # The client sends the peer window key at two different casings — the
      # #532 prod evidence (`NickTemporaneo` then `nicktemporaneo`). Both
      # must land on ONE cursor row (the read path already resolves the
      # window case-insensitively via canonical_nick/1).
      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "NickTemp", m1.id)
      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "nicktemp", m2.id)

      query = from(c in Cursor, where: c.user_id == ^user.id and c.network_id == ^net.id)
      rows = Repo.all(query)
      assert length(rows) == 1
      assert hd(rows).last_read_message_id == m2.id
      # Stored key is the fold, not the raw casing the caller happened to send.
      assert hd(rows).channel == "nicktemp"
    end

    test "get/3 resolves a DM window regardless of the casing looked up" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "NickTemp", 1)

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "NickTemp", msg.id)

      assert %Cursor{last_read_message_id: id} =
               ReadCursor.get({:user, user.id}, net.id, "NICKTEMP")

      assert id == msg.id
    end
  end

  # ---------------------------------------------------------------------------
  # set/4 — happy path
  # ---------------------------------------------------------------------------

  describe "set/4 — insert path" do
    test "creates a cursor when none exists for (subject, network, channel)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#sniffo", 1)

      assert {:ok, %Cursor{} = cursor} =
               ReadCursor.set({:user, user.id}, net.id, "#sniffo", msg.id)

      assert cursor.last_read_message_id == msg.id
      assert cursor.user_id == user.id
    end

    test "creates a cursor for a visitor subject" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      msg = insert_message(%{visitor_id: visitor.id}, net.id, "#sniffo", 1)

      assert {:ok, %Cursor{} = cursor} =
               ReadCursor.set({:visitor, visitor.id}, net.id, "#sniffo", msg.id)

      assert cursor.visitor_id == visitor.id
      assert cursor.user_id == nil
    end

    test "creates a cursor for the synthetic $server window — no carve-outs (plan O3)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "$server", 1, "MOTD line")

      assert {:ok, %Cursor{channel: "$server"}} =
               ReadCursor.set({:user, user.id}, net.id, "$server", msg.id)
    end
  end

  describe "set/4 — monotonic advance" do
    test "setting to a higher id updates the cursor" do
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)

      {:ok, %Cursor{last_read_message_id: id1}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", m1.id)

      assert id1 == m1.id

      {:ok, %Cursor{last_read_message_id: id2}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", m2.id)

      assert id2 == m2.id
    end

    test "setting to the same id is a no-op (returns existing cursor)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#x", 1)

      {:ok, %Cursor{id: cursor_id, last_read_message_id: stored_id}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", msg.id)

      {:ok, %Cursor{id: ^cursor_id, last_read_message_id: ^stored_id}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", msg.id)
    end

    test "setting to a lower id is a no-op — cursor stays at the higher id (#233 monotonic)" do
      # #233: `set/4` is advance-only. A stale (lower) POST — e.g. the
      # currently-loaded page bottom arriving during a ~1.5s message-page
      # load while the operator taps scroll-to-bottom — MUST NOT regress
      # the cursor. Pre-fix `do_set/4` was last-write-wins and wrote the
      # lower id, whose `read_cursor_set` broadcast snapped every cic view
      # back to the old read marker ~2s later. The clamp returns the
      # EXISTING (higher) cursor unchanged, so the stale POST re-affirms
      # the correct position instead of regressing it. Deliberate
      # mark-as-unread (the one legitimate backward move) has no caller
      # today and, when built, gets its OWN explicit path — see the
      # `Grappa.ReadCursor` moduledoc + DESIGN_NOTES 2026-07-14.
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)
      m2_id = m2.id

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#x", m2.id)

      # Stale lower POST returns the current higher cursor, no write.
      {:ok, %Cursor{last_read_message_id: ^m2_id}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", m1.id)

      # And the stored row is unchanged — the guard did not persist m1.
      assert %Cursor{last_read_message_id: ^m2_id} =
               ReadCursor.get({:user, user.id}, net.id, "#x")
    end

    test "a NULL'd cursor (ON DELETE SET NULL purge) still advances on the next set (#233)" do
      # `read_cursors.last_read_message_id` is `REFERENCES messages(id)
      # ON DELETE SET NULL` — the user-facing archive-delete path
      # (`Scrollback.delete_for_channel/3`) bulk-deletes messages and
      # leaves the cursor row alive with `last_read_message_id = NULL`
      # (the migration explicitly designs for recovery on the next set).
      # The monotonic clamp MUST NOT strand that row: in Elixir term
      # order a number sorts BEFORE any atom, so `message_id <= nil` is
      # `true` for every id — a naive `<= current` guard would treat
      # every future POST as a no-op and freeze the cursor at NULL
      # forever (and hand the controller a nil id that crashes
      # `broadcast_set/5`'s `is_integer` guard → 500). The guard is
      # `is_integer(current) and message_id <= current`, so a NULL cursor
      # falls through to the update clause and recovers.
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#x", m1.id)

      # Purge the channel's messages → FK nilifies the cursor row.
      {:ok, _} = Grappa.Scrollback.delete_for_channel({:user, user.id}, net.id, "#x")

      assert %Cursor{last_read_message_id: nil} =
               ReadCursor.get({:user, user.id}, net.id, "#x")

      # A fresh message + valid set must ADVANCE the NULL'd cursor, not
      # clamp it to NULL.
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)
      m2_id = m2.id

      assert {:ok, %Cursor{last_read_message_id: ^m2_id}} =
               ReadCursor.set({:user, user.id}, net.id, "#x", m2.id)

      assert %Cursor{last_read_message_id: ^m2_id} =
               ReadCursor.get({:user, user.id}, net.id, "#x")
    end
  end

  # ---------------------------------------------------------------------------
  # set/4 — validation
  # ---------------------------------------------------------------------------

  describe "set/4 — message validation" do
    test "rejects an absent message_id with :invalid_message" do
      user = user_fixture()
      net = network_fixture()

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, user.id}, net.id, "#x", 999_999_999)
    end

    test "rejects a message belonging to a different network" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()
      msg = insert_message(%{user_id: user.id}, net1.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, user.id}, net2.id, "#x", msg.id)
    end

    test "rejects a message belonging to a different channel" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, user.id}, net.id, "#y", msg.id)
    end

    test "rejects a message belonging to a different subject" do
      alice = user_fixture()
      bob = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: alice.id}, net.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, bob.id}, net.id, "#x", msg.id)
    end

    # UX-6 bucket K — PM cursor accepts inbound DM rows stored under
    # `channel = own_nick, dm_with = peer`.
    #
    # Production bug (vjt 2026-05-20): in-pane unread-marker for a peer
    # query window did NOT clear on focus; cic's POST to
    # `/networks/:slug/channels/:peer/read-cursor` 422'd because
    # `message_belongs?/4` filtered on `m.channel == ^peer` alone — but
    # inbound DMs from `peer` land at `channel = own_nick, dm_with = peer`
    # (CP14-B3 derivation, see lib/grappa/scrollback.ex moduledoc). The
    # validator's predicate diverged from `Scrollback.fetch/6`'s
    # `channel_or_dm_where/3` (peer-DM aggregation `m.channel == ^peer OR
    # m.dm_with == ^peer`). One predicate now both reads + writes the
    # cursor — the divergence WAS the bug.
    #
    # Outbound DMs (`channel = peer, dm_with = peer`) already worked
    # because the literal `m.channel == ^peer` match passed. That's why
    # "sending a message to peer cleared the marker" — only outbound
    # passed the validator. K closes the inbound case.
    test "accepts an inbound DM whose channel is own_nick and dm_with is peer" do
      user = user_fixture()
      net = network_fixture()
      own_nick = "vjt-grappa"
      peer = "cristobot"

      # Inbound DM as persisted by EventRouter: channel = own_nick,
      # dm_with = peer. cic POSTs the cursor for the peer's query
      # window (channel-URL-segment = peer); the validator MUST find
      # this row via the same OR-shape Scrollback.fetch uses.
      {:ok, msg} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: own_nick,
          dm_with: peer,
          server_time: 1,
          kind: :privmsg,
          sender: peer,
          body: "hi"
        })

      assert {:ok, cursor} = ReadCursor.set({:user, user.id}, net.id, peer, msg.id)
      assert cursor.last_read_message_id == msg.id
      # Cursor row stores the peer (the operator-facing window
      # identity), NOT the own_nick storage key.
      assert cursor.channel == peer
    end

    test "accepts an outbound DM (channel = peer, dm_with = peer) under peer-window cursor" do
      # Anti-spec guard: the new OR-shape must not regress the outbound
      # path. Outbound DMs land at `channel = peer, dm_with = peer` and
      # were already valid under the old literal predicate; they MUST
      # remain valid under the new disjunction.
      user = user_fixture()
      net = network_fixture()
      peer = "cristobot"

      {:ok, msg} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: peer,
          dm_with: peer,
          server_time: 1,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "yo"
        })

      assert {:ok, cursor} = ReadCursor.set({:user, user.id}, net.id, peer, msg.id)
      assert cursor.last_read_message_id == msg.id
    end

    test "still rejects a channel row when the cursor URL segment is a different channel" do
      # Anti-spec guard: the DM aggregation MUST only apply to
      # nick-shaped (DM-eligible) cursor targets. A channel-shaped
      # cursor (`#x`) must NOT match a different channel's row even
      # if dm_with happened to match by accident — channel rows always
      # store `dm_with = nil` per `validate_dm_with_for_kind` so this
      # is a paranoid guard against future schema drift.
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#a", 1)

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, user.id}, net.id, "#b", msg.id)
    end

    test "DM validator does NOT cross-leak rows between different peers" do
      # Anti-spec guard: a DM row with dm_with = peerA MUST NOT validate
      # a cursor for peerB. The OR-shape narrows to a single peer.
      user = user_fixture()
      net = network_fixture()
      own_nick = "vjt-grappa"
      peer_a = "alice"
      peer_b = "bob"

      {:ok, msg} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: own_nick,
          dm_with: peer_a,
          server_time: 1,
          kind: :privmsg,
          sender: peer_a,
          body: "from alice"
        })

      assert {:error, :invalid_message} =
               ReadCursor.set({:user, user.id}, net.id, peer_b, msg.id)
    end
  end

  # ---------------------------------------------------------------------------
  # bulk_for_subject/1
  # ---------------------------------------------------------------------------

  describe "bulk_for_subject/1" do
    test "returns an empty map when the subject has no cursors" do
      user = user_fixture()
      assert %{} == ReadCursor.bulk_for_subject({:user, user.id})
    end

    test "groups cursors by network_slug, then channel" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net1.id, "#a", 1)
      m2 = insert_message(%{user_id: user.id}, net1.id, "#b", 1)
      m3 = insert_message(%{user_id: user.id}, net2.id, "#c", 1)

      {:ok, _} = ReadCursor.set({:user, user.id}, net1.id, "#a", m1.id)
      {:ok, _} = ReadCursor.set({:user, user.id}, net1.id, "#b", m2.id)
      {:ok, _} = ReadCursor.set({:user, user.id}, net2.id, "#c", m3.id)

      envelope = ReadCursor.bulk_for_subject({:user, user.id})

      assert envelope[net1.slug] == %{"#a" => m1.id, "#b" => m2.id}
      assert envelope[net2.slug] == %{"#c" => m3.id}
    end

    test "isolates by subject — does not leak alice's cursors into bob's bulk fetch" do
      alice = user_fixture()
      bob = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: alice.id}, net.id, "#x", 1)

      {:ok, _} = ReadCursor.set({:user, alice.id}, net.id, "#x", msg.id)

      assert %{} == ReadCursor.bulk_for_subject({:user, bob.id})
    end
  end

  # ---------------------------------------------------------------------------
  # broadcast_set/4
  # ---------------------------------------------------------------------------

  describe "broadcast_set/5" do
    test "emits a typed read_cursor_set payload (with badge_count) on the per-channel topic" do
      user_name = "rc-broadcast-user-#{uniq()}"
      slug = "rc-broadcast-net-#{uniq()}"
      channel = "#sniffo"
      message_id = 42
      badge_count = 7
      topic = Topic.channel(user_name, slug, channel)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      :ok = ReadCursor.broadcast_set(user_name, slug, channel, message_id, badge_count)

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{
          kind: :read_cursor_set,
          last_read_message_id: ^message_id,
          badge_count: ^badge_count
        }
      }
    end
  end

  # ---------------------------------------------------------------------------
  # clear_all_for_user/1
  # ---------------------------------------------------------------------------

  describe "clear_all_for_user/1" do
    test "deletes every cursor row for the given user_id" do
      user = user_fixture()
      other = user_fixture()
      net = network_fixture()
      msg_a = insert_message(%{user_id: user.id}, net.id, "#a", 1)
      msg_b = insert_message(%{user_id: user.id}, net.id, "#b", 1)
      msg_o = insert_message(%{user_id: other.id}, net.id, "#a", 1)
      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#a", msg_a.id)
      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#b", msg_b.id)
      {:ok, _} = ReadCursor.set({:user, other.id}, net.id, "#a", msg_o.id)

      assert :ok = ReadCursor.clear_all_for_user(user.id)

      assert ReadCursor.get({:user, user.id}, net.id, "#a") == nil
      assert ReadCursor.get({:user, user.id}, net.id, "#b") == nil

      assert %Cursor{last_read_message_id: kept_id} =
               ReadCursor.get({:user, other.id}, net.id, "#a")

      assert kept_id == msg_o.id
    end

    test "is idempotent when user has no cursors" do
      user = user_fixture()
      assert :ok = ReadCursor.clear_all_for_user(user.id)
    end
  end

  # ---------------------------------------------------------------------------
  # force_set/4 — test-support backward seed
  # ---------------------------------------------------------------------------

  describe "force_set/4 — test-support backward seed" do
    test "writes a LOWER id, bypassing the monotonic clamp set/4 enforces (#233)" do
      # #233 made `set/4` advance-only. The e2e cursor/divider specs
      # must plant a BACKWARD (mid-page) cursor to stage an
      # unread-divider scenario, which `set/4` correctly refuses.
      # `force_set/4` is the test-only backward-seed path (its sole
      # caller is the compile-gated `GrappaWeb.TestReadCursorController`)
      # — it writes any belonging id unconditionally so the seed lands.
      # This is NOT the production mark-as-unread path (still unbuilt).
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)
      m1_id = m1.id

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#x", m2.id)

      # `set/4` clamps this backward move; `force_set/4` writes it.
      assert {:ok, %Cursor{last_read_message_id: ^m1_id}} =
               ReadCursor.force_set({:user, user.id}, net.id, "#x", m1.id)

      assert %Cursor{last_read_message_id: ^m1_id} =
               ReadCursor.get({:user, user.id}, net.id, "#x")
    end

    test "inserts when no cursor exists yet" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      msg_id = msg.id

      assert {:ok, %Cursor{last_read_message_id: ^msg_id}} =
               ReadCursor.force_set({:user, user.id}, net.id, "#x", msg.id)

      assert %Cursor{last_read_message_id: ^msg_id} =
               ReadCursor.get({:user, user.id}, net.id, "#x")
    end

    test "rejects an id that does not belong to (subject, network, channel)" do
      user = user_fixture()
      net = network_fixture()
      other_net = network_fixture()
      # Message lives on a DIFFERENT network — the belongs-check must fail
      # so a forced cursor can never reference a foreign row.
      msg = insert_message(%{user_id: user.id}, other_net.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.force_set({:user, user.id}, net.id, "#x", msg.id)
    end
  end

  # S12 (2026-07-08 codebase review) — `read_cursors.last_read_message_id`
  # is `REFERENCES messages(id) ON DELETE SET NULL`. When a `messages`
  # row is deleted (the `Scrollback.delete_for_channel/3` /
  # `delete_for_dm/3` bulk-purge path drops tens of thousands in one
  # transaction under the single SQLite write lock), SQLite must locate
  # every CHILD `read_cursors` row whose FK equals the deleted parent to
  # NULL it. Without an index on the child key that is a full
  # `read_cursors` scan per deleted message — `O(deleted × read_cursors)`.
  # A prior migration dropped this index on a backwards rationale
  # ("scans by message PK, patches in place"); this asserts it was
  # recreated so the child-key lookup stays an index seek.
  describe "FK child-key index (S12)" do
    test "read_cursors has an index on last_read_message_id for the ON DELETE SET NULL purge path" do
      {:ok, %{rows: rows}} =
        Repo.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'read_cursors'")

      assert "read_cursors_last_read_message_id_index" in List.flatten(rows)
    end
  end

  describe "#525 — ASCII channel cursor convergence" do
    test "set/get converge across ASCII case spellings — one cursor, no fork" do
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#Chan[1]", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#CHAN[1]", 2)

      # Both messages land under the folded key (canonical storage: A-Z
      # lower, brackets preserved — CASEMAPPING=ascii).
      assert m1.channel == "#chan[1]"
      assert m2.channel == "#chan[1]"

      {:ok, c1} = ReadCursor.set({:user, user.id}, net.id, "#chan[1]", m1.id)

      # A set under a case variant hits the SAME cursor row (no fork past
      # the UNIQUE (subject, network, channel) index) and advances.
      {:ok, c2} = ReadCursor.set({:user, user.id}, net.id, "#CHAN[1]", m2.id)

      assert c1.id == c2.id
      assert c2.last_read_message_id == m2.id

      # get under any case spelling returns that one cursor.
      for spelling <- ["#chan[1]", "#CHAN[1]", "#Chan[1]"] do
        cursor = ReadCursor.get({:user, user.id}, net.id, spelling)
        assert cursor.id == c1.id, "spelling #{spelling} did not converge"
        assert cursor.last_read_message_id == m2.id
      end

      # The brace twin is a DIFFERENT channel — it does NOT converge.
      assert ReadCursor.get({:user, user.id}, net.id, "#chan{1}") == nil
    end
  end

  # ---------------------------------------------------------------------------
  # rename_dm_peer/4 (#373 — DM read cursor follows a peer NICK)
  # ---------------------------------------------------------------------------

  describe "rename_dm_peer/4" do
    # Seed a DM cursor for `peer` (inbound shape: channel=own_nick,
    # dm_with=peer) and return {message, cursor}.
    defp seed_dm_cursor(subject_attrs, subject, network_id, peer, own_nick, server_time) do
      {:ok, msg} =
        ScrollbackHelpers.insert(
          Map.merge(subject_attrs, %{
            network_id: network_id,
            channel: own_nick,
            dm_with: peer,
            server_time: server_time,
            kind: :privmsg,
            sender: peer,
            body: "hi #{server_time}"
          })
        )

      {:ok, _} = ReadCursor.set(subject, network_id, peer, msg.id)
      msg
    end

    test "migrates the cursor old -> new so the new window keeps its read state" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      msg = seed_dm_cursor(%{user_id: user.id}, subject, net.id, "Guest87449", "vjt-grappa", 1)

      assert :ok = ReadCursor.rename_dm_peer(subject, net.id, "Guest87449", "NickTemporaneo")

      assert %Cursor{last_read_message_id: id} =
               ReadCursor.get(subject, net.id, "NickTemporaneo")

      assert id == msg.id
      assert ReadCursor.get(subject, net.id, "Guest87449") == nil
    end

    test "ASCII fold: a 'nick[1]' cursor migrates when matched via 'NICK[1]' (#525)" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      msg = seed_dm_cursor(%{user_id: user.id}, subject, net.id, "nick[1]", "vjt-grappa", 1)

      assert :ok = ReadCursor.rename_dm_peer(subject, net.id, "NICK[1]", "renamed")

      assert %Cursor{last_read_message_id: id} = ReadCursor.get(subject, net.id, "renamed")
      assert id == msg.id
      assert ReadCursor.get(subject, net.id, "nick[1]") == nil
    end

    test "case-only fold (old == new) is a noop — cursor untouched" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      _ = seed_dm_cursor(%{user_id: user.id}, subject, net.id, "Foo", "vjt-grappa", 1)

      assert :ok = ReadCursor.rename_dm_peer(subject, net.id, "Foo", "FOO")

      assert %Cursor{} = ReadCursor.get(subject, net.id, "Foo")
    end

    test "no cursor for old nick is a noop" do
      user = user_fixture()
      net = network_fixture()
      assert :ok = ReadCursor.rename_dm_peer({:user, user.id}, net.id, "ghost", "phantom")
    end

    test "collision merge: renaming old -> new when a new cursor exists keeps new, drops old" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      _ = seed_dm_cursor(%{user_id: user.id}, subject, net.id, "old", "vjt-grappa", 1)
      new_msg = seed_dm_cursor(%{user_id: user.id}, subject, net.id, "new", "vjt-grappa", 2)

      assert :ok = ReadCursor.rename_dm_peer(subject, net.id, "old", "new")

      # One cursor survives — the pre-existing "new" (keep-new merge).
      assert %Cursor{last_read_message_id: id} = ReadCursor.get(subject, net.id, "new")
      assert id == new_msg.id
      assert ReadCursor.get(subject, net.id, "old") == nil
    end

    test "isolated by subject — alice's cursor survives a vjt rename" do
      vjt = user_fixture()
      alice = user_fixture()
      net = network_fixture()
      _ = seed_dm_cursor(%{user_id: alice.id}, {:user, alice.id}, net.id, "peer", "alice", 1)

      assert :ok = ReadCursor.rename_dm_peer({:user, vjt.id}, net.id, "peer", "peer2")

      assert %Cursor{} = ReadCursor.get({:user, alice.id}, net.id, "peer")
    end

    # Parity-matrix (feedback_e2e_user_class_parity_matrix): the effect fires
    # for any subject; one visitor case proves the XOR-FK path.
    test "visitor subject: cursor migrates old -> new (parity)" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      subject = {:visitor, visitor.id}
      msg = seed_dm_cursor(%{visitor_id: visitor.id}, subject, net.id, "Guest99", "guest-nick", 1)

      assert :ok = ReadCursor.rename_dm_peer(subject, net.id, "Guest99", "RealNick")

      assert %Cursor{last_read_message_id: id} = ReadCursor.get(subject, net.id, "RealNick")
      assert id == msg.id
      assert ReadCursor.get(subject, net.id, "Guest99") == nil
    end
  end

  # ---------------------------------------------------------------------------
  # #396 — bulk_unread_split/1 + bulk_unread_content_tails/2: the WHOLE
  # subject's per-window counts / capped mention tails in ONE query each,
  # driven by the read cursors via #393's unified
  # `nick_fold(COALESCE(dm_with, channel))` window predicate.
  # ---------------------------------------------------------------------------
  describe "bulk_unread_split/1" do
    test "splits content vs presence per window, across channels + DM + networks" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net_a = network_fixture()
      net_b = network_fixture()

      # net_a #chan: anchor + 2 content + 1 join after the cursor.
      a = insert_message(attrs, net_a.id, "#chan", 1)
      insert_message(attrs, net_a.id, "#chan", 2, "c1")
      insert_message(attrs, net_a.id, "#chan", 3, "c2")

      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net_a.id,
            channel: "#chan",
            server_time: 4,
            kind: :join,
            sender: "bob",
            body: nil
          })
        )

      {:ok, _} = ReadCursor.set(subject, net_a.id, "#chan", a.id)

      # net_a DM peer: inbound (channel=own, dm_with=peer) + outbound.
      di = dm_row(attrs, net_a.id, "vjt", "peer", 5, "in")
      dm_row(attrs, net_a.id, "peer", "peer", 6, "out")
      {:ok, _} = ReadCursor.set(subject, net_a.id, "peer", di.id)

      # net_b #ops: anchor + 1 content.
      b = insert_message(attrs, net_b.id, "#ops", 1)
      insert_message(attrs, net_b.id, "#ops", 2, "b1")
      {:ok, _} = ReadCursor.set(subject, net_b.id, "#ops", b.id)

      own_nicks = %{net_a.slug => {net_a.id, "vjt"}, net_b.slug => {net_b.id, "vjt"}}
      split = ReadCursor.bulk_unread_split(subject, own_nicks, %{})

      assert split[net_a.slug]["#chan"] == %{messages: 2, events: 1}
      assert split[net_a.slug]["peer"] == %{messages: 1, events: 0}
      assert split[net_b.slug]["#ops"] == %{messages: 1, events: 0}
    end

    test "a window read to the tail is present with zero counts (LEFT JOIN)" do
      user = user_fixture()
      subject = {:user, user.id}
      net = network_fixture()

      m = insert_message(%{user_id: user.id}, net.id, "#chan", 1)
      {:ok, _} = ReadCursor.set(subject, net.id, "#chan", m.id)

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["#chan"] ==
               %{messages: 0, events: 0}
    end

    test "returns an empty envelope for a subject with no cursors" do
      user = user_fixture()
      assert ReadCursor.bulk_unread_split({:user, user.id}, %{}, %{}) == %{}
    end

    test "excludes the subject's OWN presence rows from events (#532 A)" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      a = insert_message(attrs, net.id, "#chan", 1)

      # Own self-PART after the cursor — the exact #532 A shape (leaving a
      # channel left a permanent unread the operator couldn't clear).
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 2,
            kind: :part,
            sender: "vjt",
            body: nil
          })
        )

      # An other-user presence event must still count.
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 3,
            kind: :join,
            sender: "bob",
            body: nil
          })
        )

      {:ok, _} = ReadCursor.set(subject, net.id, "#chan", a.id)

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["#chan"] ==
               %{messages: 0, events: 1}
    end

    test "excludes the subject's OWN terminal self-rename via meta.new_nick (#532 A/H1)" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      a = insert_message(attrs, net.id, "#chan", 1)

      # Own self-NICK: EventRouter persists the :nick_change with
      # sender=OLD and meta.new_nick=NEW; the live own_nick is the NEW
      # one, so only the meta.new_nick clause catches this row. It must
      # NOT count (else every /nick left a permanent $server +1 — the
      # exact #532 symptom). sender != own_nick here, proving the clause
      # is not a no-op the sender check already covers.
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 2,
            kind: :nick_change,
            sender: "oldvjt",
            body: nil,
            meta: %{new_nick: "vjt"}
          })
        )

      # A PEER rename (meta.new_nick is someone else) must still count.
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 3,
            kind: :nick_change,
            sender: "bob",
            body: nil,
            meta: %{new_nick: "carol"}
          })
        )

      {:ok, _} = ReadCursor.set(subject, net.id, "#chan", a.id)

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["#chan"] ==
               %{messages: 0, events: 1}
    end

    test "excludes the subject's OWN content rows from messages (#576)" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      # DM window "peer": anchor the cursor, then the operator's OWN
      # outbound line + a peer reply. The reported bug is a DM badge whose
      # count is only the operator's own lines — content is read BY
      # DEFINITION, so the #396 cold-load twin must strip it exactly as
      # count_after_split/6 does (one rule, both count doors).
      a = dm_row(attrs, net.id, "vjt", "peer", 1, "anchor")
      {:ok, _} = ReadCursor.set(subject, net.id, "peer", a.id)

      # Own outbound (channel = peer ⟹ sender = own_nick) — must NOT count.
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "peer",
            server_time: 2,
            kind: :privmsg,
            sender: "vjt",
            body: "my line",
            dm_with: "peer"
          })
        )

      # Peer reply (channel = own_nick, dm_with = peer) — counts.
      dm_row(attrs, net.id, "vjt", "peer", 3, "their line")

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["peer"] ==
               %{messages: 1, events: 0}
    end

    test "own-content exclusion folds the nick (ASCII A-Z, #576/#372)" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      a = insert_message(attrs, net.id, "#chan", 1)
      {:ok, _} = ReadCursor.set(subject, net.id, "#chan", a.id)

      # Own content with a DIFFERENT casing than the live own_nick — the
      # fold MATCH (`nick_fold(sender)`) must still drop it (`sender` is
      # stored RAW for display).
      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 2,
            kind: :privmsg,
            sender: "VJT",
            body: "shout"
          })
        )

      # A peer line still counts.
      insert_message(attrs, net.id, "#chan", 3, "peer line")

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["#chan"] ==
               %{messages: 1, events: 0}
    end

    test "own content COUNTS in the own-nick SELF window (#576 × #396 carve-out)" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      # Self window (cursor keyed to own nick "vjt"): a note-to-self is
      # legitimate payload that must still count (#396). The per-row
      # self-window test in `own_authored_dynamic` (`nick_fold(rc.channel) !=
      # folded`) spares own content HERE while dropping it in peer / channel
      # windows.
      {:ok, a} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "vjt",
            server_time: 1,
            kind: :privmsg,
            sender: "vjt",
            body: "self anchor",
            dm_with: "vjt"
          })
        )

      {:ok, _} = ReadCursor.set(subject, net.id, "vjt", a.id)

      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "vjt",
            server_time: 2,
            kind: :privmsg,
            sender: "vjt",
            body: "note to self",
            dm_with: "vjt"
          })
        )

      own_nicks = %{net.slug => {net.id, "vjt"}}

      assert ReadCursor.bulk_unread_split(subject, own_nicks, %{})[net.slug]["vjt"] ==
               %{messages: 1, events: 0}
    end
  end

  describe "bulk_unread_content_tails/2" do
    test "caps each window independently at `cap` oldest content rows" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      a = insert_message(attrs, net.id, "#big", 1)
      # 5 unread content rows after the cursor; cap to 3.
      for st <- 2..6, do: insert_message(attrs, net.id, "#big", st, "line-#{st}")
      {:ok, _} = ReadCursor.set(subject, net.id, "#big", a.id)

      # A second window must NOT be starved by the first's volume.
      b = insert_message(attrs, net.id, "#small", 1)
      insert_message(attrs, net.id, "#small", 2, "only")
      {:ok, _} = ReadCursor.set(subject, net.id, "#small", b.id)

      tails = ReadCursor.bulk_unread_content_tails(subject, 3)

      assert length(tails[net.slug]["#big"]) == 3
      # Oldest-first within the cap.
      assert Enum.map(tails[net.slug]["#big"], & &1.body) == ["line-2", "line-3", "line-4"]
      assert length(tails[net.slug]["#small"]) == 1
    end

    test "excludes presence rows — only content is a mention candidate" do
      user = user_fixture()
      subject = {:user, user.id}
      attrs = %{user_id: user.id}
      net = network_fixture()

      a = insert_message(attrs, net.id, "#chan", 1)
      insert_message(attrs, net.id, "#chan", 2, "content")

      {:ok, _} =
        ScrollbackHelpers.insert(
          Map.merge(attrs, %{
            network_id: net.id,
            channel: "#chan",
            server_time: 3,
            kind: :join,
            sender: "bob",
            body: nil
          })
        )

      {:ok, _} = ReadCursor.set(subject, net.id, "#chan", a.id)

      tails = ReadCursor.bulk_unread_content_tails(subject, 100)

      assert Enum.map(tails[net.slug]["#chan"], & &1.body) == ["content"]
    end
  end

  # Inserts a DM row (channel + dm_with), returns the persisted message.
  defp dm_row(attrs, network_id, channel, dm_with, server_time, body) do
    {:ok, message} =
      ScrollbackHelpers.insert(
        Map.merge(attrs, %{
          network_id: network_id,
          channel: channel,
          dm_with: dm_with,
          server_time: server_time,
          kind: :privmsg,
          sender: "peer",
          body: body
        })
      )

    message
  end
end
