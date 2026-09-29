defmodule Grappa.DmConversationsTest do
  @moduledoc """
  issue 1365 leg 1 — the `dm_conversations` identity and every writer that
  keeps it true while `query_windows` and the nick columns stay written
  beside it.

  The invariant under test everywhere below is
  `DmConversationsHelpers.divergent_message_ids/0 == []`: every DM row points
  at the conversation its key names, and no other row points anywhere. It is
  an SQL oracle independent of the code under test; its negative control
  lives in the "the oracle" describe block.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts.User
  alias Grappa.{DmConversations, DmConversationsHelpers}
  alias Grappa.DmConversations.Conversation
  alias Grappa.{QueryWindows, ReadCursor, Scrollback, ScrollbackHelpers}
  alias Grappa.Scrollback.Message
  alias Grappa.Visitors.Visitor

  setup do
    user = user_fixture()
    net = network_fixture()
    %{user: user, net: net, subject: {:user, user.id}}
  end

  defp persist(net, subject_attrs, channel, dm_with, sender) do
    {:ok, message} =
      Scrollback.persist_event(
        Map.merge(subject_attrs, %{
          network_id: net.id,
          channel: channel,
          dm_with: dm_with,
          server_time: System.system_time(:millisecond),
          kind: :privmsg,
          sender: sender,
          body: "hello"
        })
      )

    message
  end

  defp conversations, do: Conversation |> order_by([c], c.id) |> Repo.all()

  describe "the conversation row" do
    test "resolve!/3 mints once per folded nick; a case variant is the same conversation", %{
      net: net,
      subject: subject
    } do
      first = DmConversations.resolve!(subject, net.id, "Alice")
      again = DmConversations.resolve!(subject, net.id, "ALICE")

      assert again.id == first.id
      assert first.peer_nick == "Alice"
      assert first.opened_at == nil
      assert length(conversations()) == 1
    end

    test "the fold is ASCII: nick[1] and nick{1} are two conversations", %{net: net, subject: subject} do
      bracket = DmConversations.resolve!(subject, net.id, "nick[1]")
      brace = DmConversations.resolve!(subject, net.id, "nick{1}")

      refute bracket.id == brace.id
    end

    test "the index is TOTAL: a closed conversation still owns its nick", %{net: net, subject: subject} do
      opened = DmConversations.open!(subject, net.id, "alice", ~U[2026-09-29 00:00:00Z])
      :ok = DmConversations.close(subject, net.id, "Alice")

      closed = DmConversations.get(subject, net.id, "alice")
      assert closed.id == opened.id
      assert closed.opened_at == nil

      assert DmConversations.resolve!(subject, net.id, "ALICE").id == opened.id
      assert length(conversations()) == 1
    end

    test "open!/4 keeps the first opened_at while open, and reopens a closed row", %{net: net, subject: subject} do
      first = DmConversations.open!(subject, net.id, "alice", ~U[2026-09-29 00:00:00Z])
      same = DmConversations.open!(subject, net.id, "alice", ~U[2026-09-29 01:00:00Z])
      assert same.opened_at == ~U[2026-09-29 00:00:00Z]

      :ok = DmConversations.close(subject, net.id, "alice")
      reopened = DmConversations.open!(subject, net.id, "alice", ~U[2026-09-29 02:00:00Z])

      assert reopened.id == first.id
      assert reopened.opened_at == ~U[2026-09-29 02:00:00Z]
    end

    test "a user and a visitor with the same peer own two conversations", %{net: net, subject: subject} do
      visitor = visitor_fixture(network_slug: net.slug)

      mine = DmConversations.resolve!(subject, net.id, "alice")
      theirs = DmConversations.resolve!({:visitor, visitor.id}, net.id, "alice")

      refute mine.id == theirs.id
    end
  end

  describe "Scrollback.persist_event/1 — first contact mints, every DM row points" do
    test "inbound and outbound rows of one peer share one conversation, spelled as first seen", %{
      user: user,
      net: net
    } do
      inbound = persist(net, %{user_id: user.id}, "me", "Alice", "Alice")
      outbound = persist(net, %{user_id: user.id}, "alice", "alice", "me")

      assert [%Conversation{id: id, peer_nick: "Alice", opened_at: nil}] = conversations()
      assert inbound.dm_conversation_id == id
      assert outbound.dm_conversation_id == id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "channel and $server rows belong to no conversation and mint none", %{user: user, net: net} do
      channel_row = persist(net, %{user_id: user.id}, "#grappa", nil, "alice")
      server_row = persist(net, %{user_id: user.id}, "$server", nil, "irc.example.org")

      assert channel_row.dm_conversation_id == nil
      assert server_row.dm_conversation_id == nil
      assert conversations() == []
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "an untagged DM-eligible row (a service notice keyed on the service) gets its conversation", %{
      user: user,
      net: net
    } do
      row = persist(net, %{user_id: user.id}, "NickServ", nil, "NickServ")

      assert [%Conversation{id: id}] = conversations()
      assert row.dm_conversation_id == id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a visitor's DM row points at the visitor's conversation", %{net: net} do
      visitor = visitor_fixture(network_slug: net.slug)
      row = persist(net, %{visitor_id: visitor.id}, "me", "alice", "alice")

      assert [%Conversation{id: id, visitor_id: visitor_id, user_id: nil}] = conversations()
      assert visitor_id == visitor.id
      assert row.dm_conversation_id == id
    end
  end

  describe "QueryWindows — the dual write of open state" do
    test "open/4 opens the conversation, close/4 closes it and keeps the row", %{
      user: user,
      net: net,
      subject: subject
    } do
      {:ok, window} = QueryWindows.open(subject, net.id, "Alice", user.name)

      assert [%Conversation{id: id, peer_nick: "Alice", opened_at: opened_at}] = conversations()
      assert opened_at == window.opened_at

      :ok = QueryWindows.close(subject, net.id, "alice", user.name)

      assert [%Conversation{id: ^id, opened_at: nil}] = conversations()
      refute QueryWindows.open?(subject, net.id, "alice")
    end

    test "opening a window on a peer with history opens THAT conversation", %{
      user: user,
      net: net,
      subject: subject
    } do
      row = persist(net, %{user_id: user.id}, "me", "alice", "alice")
      {:ok, _} = QueryWindows.open(subject, net.id, "ALICE", user.name)

      assert [%Conversation{id: id, opened_at: %DateTime{}}] = conversations()
      assert row.dm_conversation_id == id
    end
  end

  describe "ReadCursor — a new DM cursor points at its conversation" do
    test "a DM cursor carries the id, a channel cursor carries none", %{user: user, net: net, subject: subject} do
      dm = persist(net, %{user_id: user.id}, "me", "alice", "alice")
      chan = persist(net, %{user_id: user.id}, "#grappa", nil, "alice")

      {:ok, dm_cursor} = ReadCursor.set(subject, net.id, "Alice", dm.id)
      {:ok, chan_cursor} = ReadCursor.set(subject, net.id, "#grappa", chan.id)

      assert dm_cursor.dm_conversation_id == dm.dm_conversation_id
      assert chan_cursor.dm_conversation_id == nil
    end
  end

  describe "the NO ACTION child FK does not block the subject cascades" do
    test "deleting a user takes its conversations and their DM rows in one statement", %{
      user: user,
      net: net,
      subject: subject
    } do
      # Both `messages` and `dm_conversations` cascade from `users`; the FK
      # between them is NO ACTION, which SQLite checks at the END of the
      # statement — by then the children are gone too. A regression here
      # would make account deletion fail on the first user with a DM.
      dm = persist(net, %{user_id: user.id}, "me", "alice", "alice")
      {:ok, _} = ReadCursor.set(subject, net.id, "alice", dm.id)

      assert {1, _} = User |> where([u], u.id == ^user.id) |> Repo.delete_all()
      assert conversations() == []
    end

    test "deleting a visitor does the same", %{net: net} do
      visitor = visitor_fixture(network_slug: net.slug)
      _ = persist(net, %{visitor_id: visitor.id}, "me", "alice", "alice")

      assert {1, _} = Visitor |> where([v], v.id == ^visitor.id) |> Repo.delete_all()
      assert conversations() == []
    end
  end

  describe "the oracle" do
    test "it is not zero by construction: a row in the WRONG conversation is reported", %{
      user: user,
      net: net
    } do
      # The negative control for every `== []` in this file. The mis-attach it
      # plants is the realistic one — an inbound row filed under the channel
      # it was received on (our own nick) instead of its peer — which is
      # exactly what grouping on `channel` instead of `COALESCE(dm_with,
      # channel)` would do.
      inbound = persist(net, %{user_id: user.id}, "me", "alice", "alice")
      _ = persist(net, %{user_id: user.id}, "me", "me", "me")
      wrong = DmConversations.get({:user, user.id}, net.id, "me")

      Message
      |> where([m], m.id == ^inbound.id)
      |> Repo.update_all(set: [dm_conversation_id: wrong.id])

      assert DmConversationsHelpers.divergent_message_ids() == [inbound.id]
    end

    test "a legacy row with no FK is reported until something attaches it", %{user: user, net: net} do
      {:ok, legacy} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: "alice",
          dm_with: "alice",
          server_time: 1,
          kind: :privmsg,
          sender: "me",
          body: "pre-1365"
        })

      assert DmConversationsHelpers.divergent_message_ids() == [legacy.id]
    end
  end
end
