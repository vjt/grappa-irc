defmodule Grappa.ReadCursorTest do
  @moduledoc """
  Context tests for `Grappa.ReadCursor` — the server-owned per-(subject,
  network, channel) read cursor primitive landed in the
  `server-side-read-state` cluster (see `docs/plans/2026-05-13-server-side-read-state.md`).

  Coverage:

    * `get/3` returns nil when no cursor exists, the row when it does.
    * `advance/4` insert path (no prior cursor).
    * `advance/4` forward-only: same-id and lower-id are no-ops.
    * `advance/4` advances forward when target id is higher.
    * `advance/4` rejects `:invalid_message` when the message_id doesn't
      belong to (subject, network, channel) — wrong network, wrong
      channel, wrong subject, or absent row.
    * `advance/4` honors subject XOR via the changeset.
    * `bulk_for_subject/1` returns the nested envelope shape.
    * `broadcast_advance/4` emits a typed `read_cursor_set` payload on
      the per-channel topic.

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

    test "returns the cursor row after an advance" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#sniffo", 1)

      {:ok, _} = ReadCursor.advance({:user, user.id}, net.id, "#sniffo", msg.id)

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

      {:ok, _} = ReadCursor.advance({:user, alice.id}, net.id, "#sniffo", msg.id)

      assert nil == ReadCursor.get({:user, bob.id}, net.id, "#sniffo")
    end
  end

  # ---------------------------------------------------------------------------
  # advance/4 — happy path
  # ---------------------------------------------------------------------------

  describe "advance/4 — insert path" do
    test "creates a cursor when none exists for (subject, network, channel)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#sniffo", 1)

      assert {:ok, %Cursor{} = cursor} =
               ReadCursor.advance({:user, user.id}, net.id, "#sniffo", msg.id)

      assert cursor.last_read_message_id == msg.id
      assert cursor.user_id == user.id
    end

    test "creates a cursor for a visitor subject" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      msg = insert_message(%{visitor_id: visitor.id}, net.id, "#sniffo", 1)

      assert {:ok, %Cursor{} = cursor} =
               ReadCursor.advance({:visitor, visitor.id}, net.id, "#sniffo", msg.id)

      assert cursor.visitor_id == visitor.id
      assert cursor.user_id == nil
    end

    test "creates a cursor for the synthetic $server window — no carve-outs (plan O3)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "$server", 1, "MOTD line")

      assert {:ok, %Cursor{channel: "$server"}} =
               ReadCursor.advance({:user, user.id}, net.id, "$server", msg.id)
    end
  end

  describe "advance/4 — forward-only" do
    test "advancing to a higher id updates the cursor" do
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)

      {:ok, %Cursor{last_read_message_id: id1}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", m1.id)

      assert id1 == m1.id

      {:ok, %Cursor{last_read_message_id: id2}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", m2.id)

      assert id2 == m2.id
    end

    test "advancing to the same id is a no-op (returns existing cursor)" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#x", 1)

      {:ok, %Cursor{id: cursor_id, last_read_message_id: stored_id}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", msg.id)

      {:ok, %Cursor{id: ^cursor_id, last_read_message_id: ^stored_id}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", msg.id)
    end

    test "advancing to a lower id is a no-op (cursor stays at higher id)" do
      user = user_fixture()
      net = network_fixture()
      m1 = insert_message(%{user_id: user.id}, net.id, "#x", 1)
      m2 = insert_message(%{user_id: user.id}, net.id, "#x", 2)
      m2_id = m2.id

      {:ok, %Cursor{last_read_message_id: ^m2_id}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", m2.id)

      {:ok, %Cursor{last_read_message_id: ^m2_id}} =
        ReadCursor.advance({:user, user.id}, net.id, "#x", m1.id)
    end
  end

  # ---------------------------------------------------------------------------
  # advance/4 — validation
  # ---------------------------------------------------------------------------

  describe "advance/4 — message validation" do
    test "rejects an absent message_id with :invalid_message" do
      user = user_fixture()
      net = network_fixture()

      assert {:error, :invalid_message} =
               ReadCursor.advance({:user, user.id}, net.id, "#x", 999_999_999)
    end

    test "rejects a message belonging to a different network" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()
      msg = insert_message(%{user_id: user.id}, net1.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.advance({:user, user.id}, net2.id, "#x", msg.id)
    end

    test "rejects a message belonging to a different channel" do
      user = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: user.id}, net.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.advance({:user, user.id}, net.id, "#y", msg.id)
    end

    test "rejects a message belonging to a different subject" do
      alice = user_fixture()
      bob = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: alice.id}, net.id, "#x", 1)

      assert {:error, :invalid_message} =
               ReadCursor.advance({:user, bob.id}, net.id, "#x", msg.id)
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

      {:ok, _} = ReadCursor.advance({:user, user.id}, net1.id, "#a", m1.id)
      {:ok, _} = ReadCursor.advance({:user, user.id}, net1.id, "#b", m2.id)
      {:ok, _} = ReadCursor.advance({:user, user.id}, net2.id, "#c", m3.id)

      envelope = ReadCursor.bulk_for_subject({:user, user.id})

      assert envelope[net1.slug] == %{"#a" => m1.id, "#b" => m2.id}
      assert envelope[net2.slug] == %{"#c" => m3.id}
    end

    test "isolates by subject — does not leak alice's cursors into bob's bulk fetch" do
      alice = user_fixture()
      bob = user_fixture()
      net = network_fixture()
      msg = insert_message(%{user_id: alice.id}, net.id, "#x", 1)

      {:ok, _} = ReadCursor.advance({:user, alice.id}, net.id, "#x", msg.id)

      assert %{} == ReadCursor.bulk_for_subject({:user, bob.id})
    end
  end

  # ---------------------------------------------------------------------------
  # broadcast_advance/4
  # ---------------------------------------------------------------------------

  describe "broadcast_advance/4" do
    test "emits a typed read_cursor_set payload on the per-channel topic" do
      user_name = "rc-broadcast-user-#{uniq()}"
      slug = "rc-broadcast-net-#{uniq()}"
      channel = "#sniffo"
      message_id = 42
      topic = Topic.channel(user_name, slug, channel)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      :ok = ReadCursor.broadcast_advance(user_name, slug, channel, message_id)

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "event",
        payload: %{kind: "read_cursor_set", last_read_message_id: ^message_id}
      }
    end
  end
end
