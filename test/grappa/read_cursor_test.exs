defmodule Grappa.ReadCursorTest do
  @moduledoc """
  Context tests for `Grappa.ReadCursor` — server-owned per-(subject,
  network, channel) read cursor.

  Coverage:

    * `get/3` returns nil when no cursor exists, the row when it does.
    * `set/4` insert path (no prior cursor).
    * `set/4` last-write-wins: same-id no-ops, lower-id moves backward,
      higher-id moves forward.
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

  alias Grappa.{Accounts, Networks, ReadCursor, ScrollbackHelpers, Visitors}
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

  defp insert_message(subject_attrs, network_id, channel, server_time, body \\ "msg") do
    attrs =
      Map.merge(subject_attrs, %{
        network_id: network_id,
        channel: channel,
        server_time: server_time,
        kind: :privmsg,
        sender: "vjt",
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

  describe "set/4 — last-write-wins" do
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

    test "setting to a lower id moves the cursor backward (operator scrolled up + settled)" do
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)
      m1_id = m1.id

      {:ok, _} = ReadCursor.set({:user, user.id}, net.id, "#x", m2.id)

      {:ok, %Cursor{last_read_message_id: ^m1_id}} =
        ReadCursor.set({:user, user.id}, net.id, "#x", m1.id)
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
          kind: "read_cursor_set",
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
end
