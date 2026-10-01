defmodule Grappa.NickMigrationTest do
  @moduledoc """
  The nick-rename migration set — since issue 1365, the own-nick SELF window
  only (#948). The ruling (relayed from vjt) took every peer store and the
  own-nick TAG to zero writes; what stays is `own_renamed/5` and the DM
  conversation it carries along.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{DmConversations, DmConversationsHelpers}
  alias Grappa.{NickMigration, QueryWindows, ReadCursor, Scrollback, ScrollbackHelpers}
  alias Grappa.Scrollback.Message

  defp dm(net, user, channel, dm_with, sender) do
    {:ok, message} =
      Scrollback.persist_event(%{
        network_id: net.id,
        user_id: user.id,
        channel: channel,
        dm_with: dm_with,
        server_time: System.system_time(:millisecond),
        kind: :privmsg,
        sender: sender,
        body: "hi"
      })

    message
  end

  defp fk(message_id) do
    Message
    |> where([m], m.id == ^message_id)
    |> select([m], m.dm_conversation_id)
    |> Repo.one!()
  end

  describe "issue 1365 — the DM conversation follows exactly the self rows that moved" do
    test "a rename with no collision is one UPDATE: same id, new display, still open" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldme", user.name)
      row = dm(net, user, "oldme", "oldme", "oldme")
      before = DmConversations.get(subject, net.id, "oldme")

      assert {:ok, %{window: :renamed, conversation: :renamed}} =
               NickMigration.own_renamed(subject, net.id, net.slug, "oldme", "NewMe")

      after_rename = DmConversations.get(subject, net.id, "newme")
      assert after_rename.id == before.id
      assert after_rename.peer_nick == "NewMe"
      assert after_rename.opened_at == before.opened_at
      assert DmConversations.get(subject, net.id, "oldme") == nil
      assert fk(row.id) == before.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a rename into a nick with a CLOSED conversation MERGES: children move, the loser is deleted" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      # The survivor: history with a peer who bore `newme` before we took it,
      # window closed — exactly the case ruling T1 turned into a merge by
      # making the index total.
      survivor_row = dm(net, user, "me", "newme", "newme")
      survivor = DmConversations.get(subject, net.id, "newme")
      assert survivor.opened_at == nil

      {:ok, _} = QueryWindows.open(subject, net.id, "oldme", user.name)
      loser_row = dm(net, user, "oldme", "oldme", "oldme")
      {:ok, _} = ReadCursor.set(subject, net.id, "oldme", loser_row.id)
      loser = DmConversations.get(subject, net.id, "oldme")

      assert {:ok, %{window: :renamed, conversation: :merged}} =
               NickMigration.own_renamed(subject, net.id, net.slug, "oldme", "newme")

      assert DmConversations.get(subject, net.id, "oldme") == nil
      refute Repo.get(DmConversations.Conversation, loser.id)

      merged = DmConversations.get(subject, net.id, "newme")
      assert merged.id == survivor.id
      # The window moved onto the survivor, so the survivor is open now.
      assert %DateTime{} = merged.opened_at
      assert fk(loser_row.id) == survivor.id
      assert fk(survivor_row.id) == survivor.id
      assert ReadCursor.get(subject, net.id, "newme").dm_conversation_id == survivor.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a merge larger than one batch moves every row" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      _ = dm(net, user, "me", "newme", "newme")
      {:ok, _} = QueryWindows.open(subject, net.id, "oldme", user.name)
      loser = DmConversations.get(subject, net.id, "oldme")

      # 1,201 rows: two full batches of 500 and a partial one, so the loop's
      # continue AND stop arms both run. Seeded through the test helper and
      # attached by hand — persisting them one by one would test nothing more.
      for n <- 1..1_201 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: net.id,
            channel: "oldme",
            dm_with: "oldme",
            server_time: n,
            kind: :privmsg,
            sender: "oldme",
            body: "row #{n}"
          })
      end

      Message
      |> where([m], m.dm_with == "oldme")
      |> Repo.update_all(set: [dm_conversation_id: loser.id])

      assert {:ok, %{conversation: :merged}} =
               NickMigration.own_renamed(subject, net.id, net.slug, "oldme", "newme")

      refute Message |> where([m], m.dm_conversation_id == ^loser.id) |> Repo.exists?()
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "an own-nick rename SPLITS a conversation that also holds a peer's history" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      # Before we took `oldme`, somebody else bore it and we DM'd them: an
      # outbound row keyed `oldme`, sent by us under another nick.
      peer_row = dm(net, user, "oldme", "oldme", "earlier")
      # Then we became `oldme` and wrote to ourselves: a self row, same key.
      self_row = dm(net, user, "oldme", "oldme", "oldme")
      shared = DmConversations.get(subject, net.id, "oldme")
      assert fk(peer_row.id) == shared.id
      assert fk(self_row.id) == shared.id

      assert {:ok, %{rows: 1, conversation: :split}} =
               NickMigration.own_renamed(subject, net.id, net.slug, "oldme", "newme")

      mine = DmConversations.get(subject, net.id, "newme")
      assert fk(self_row.id) == mine.id
      # The peer's history stays where its key says it lives.
      assert fk(peer_row.id) == shared.id
      assert DmConversations.get(subject, net.id, "oldme").id == shared.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end
  end
end
