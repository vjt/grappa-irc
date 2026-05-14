defmodule Grappa.Visitors.CascadeTest do
  @moduledoc """
  Visitor-parity V1 cascade verification.

  Inserts an anon visitor + one row in each of the four subject-scoped
  tables that should cascade on visitor delete (`query_windows`,
  `push_subscriptions`, `user_settings`, `read_cursors`). Calls
  `Grappa.Visitors.delete/1`. Asserts every owned row is gone, plus a
  sibling-iso check that a parallel user's rows survive untouched.

  Pre-V1 this test FAILS at fixture-insertion time — three of the four
  schemas have `user_id NOT NULL` (no `visitor_id` column at all).
  Post-V1 it passes once the XOR FK migrations + schema/context shifts
  land.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures,
    only: [network_fixture: 1, user_fixture: 1, visitor_fixture: 1]

  alias Grappa.{Push, QueryWindows, ReadCursor, Repo, UserSettings, Visitors}

  describe "Visitors.delete/1 cascade" do
    test "wipes query_window + push_subscription + user_settings + read_cursor for the visitor" do
      network = network_fixture(slug: "azzurra-cascade-#{System.unique_integer([:positive])}")
      visitor = visitor_fixture(network_slug: network.slug)
      subject = {:visitor, visitor.id}

      {:ok, _} =
        QueryWindows.open(subject, network.id, "alice", "visitor:#{visitor.id}")

      {:ok, _} =
        Push.create(subject, %{
          endpoint: "https://example.com/push/abc",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} = UserSettings.set_highlight_patterns(subject, ["foo"])

      msg = scrollback_message_fixture(visitor: visitor, network: network, channel: "#chan")
      {:ok, _} = ReadCursor.set(subject, network.id, "#chan", msg.id)

      assert count_for_visitor("query_windows", visitor.id) == 1
      assert count_for_visitor("push_subscriptions", visitor.id) == 1
      assert count_for_visitor("user_settings", visitor.id) == 1
      assert count_for_visitor("read_cursors", visitor.id) == 1

      :ok = Visitors.delete(visitor.id)

      assert count_for_visitor("query_windows", visitor.id) == 0
      assert count_for_visitor("push_subscriptions", visitor.id) == 0
      assert count_for_visitor("user_settings", visitor.id) == 0
      assert count_for_visitor("read_cursors", visitor.id) == 0
    end

    test "does not affect a sibling user's rows" do
      network = network_fixture(slug: "azzurra-iso-#{System.unique_integer([:positive])}")
      visitor = visitor_fixture(network_slug: network.slug)
      user = user_fixture(name: "iso-#{System.unique_integer([:positive])}")
      visitor_subj = {:visitor, visitor.id}
      user_subj = {:user, user.id}

      {:ok, _} =
        QueryWindows.open(visitor_subj, network.id, "alice", "visitor:#{visitor.id}")

      {:ok, _} =
        QueryWindows.open(user_subj, network.id, "alice", user.name)

      {:ok, _} =
        Push.create(visitor_subj, %{
          endpoint: "https://example.com/push/visitor",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} =
        Push.create(user_subj, %{
          endpoint: "https://example.com/push/user",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} = UserSettings.set_highlight_patterns(visitor_subj, ["foo"])
      {:ok, _} = UserSettings.set_highlight_patterns(user_subj, ["bar"])

      vmsg = scrollback_message_fixture(visitor: visitor, network: network, channel: "#chan")
      umsg = scrollback_message_fixture(user: user, network: network, channel: "#chan")
      {:ok, _} = ReadCursor.set(visitor_subj, network.id, "#chan", vmsg.id)
      {:ok, _} = ReadCursor.set(user_subj, network.id, "#chan", umsg.id)

      :ok = Visitors.delete(visitor.id)

      assert count_for_visitor("query_windows", visitor.id) == 0
      assert count_for_visitor("push_subscriptions", visitor.id) == 0
      assert count_for_visitor("user_settings", visitor.id) == 0
      assert count_for_visitor("read_cursors", visitor.id) == 0

      assert count_for_user("query_windows", user.id) == 1
      assert count_for_user("push_subscriptions", user.id) == 1
      assert count_for_user("user_settings", user.id) == 1
      assert count_for_user("read_cursors", user.id) == 1
    end
  end

  defp count_for_visitor(table, visitor_id) do
    {:ok, %{rows: [[count]]}} =
      Repo.query(
        "SELECT COUNT(*) FROM #{table} WHERE visitor_id = ?",
        [visitor_id]
      )

    count
  end

  defp count_for_user(table, user_id) do
    {:ok, %{rows: [[count]]}} =
      Repo.query(
        "SELECT COUNT(*) FROM #{table} WHERE user_id = ?",
        [user_id]
      )

    count
  end

  defp scrollback_message_fixture(opts) do
    network = Keyword.fetch!(opts, :network)
    channel = Keyword.fetch!(opts, :channel)

    base = %{
      channel: channel,
      server_time: System.os_time(:millisecond),
      kind: :privmsg,
      sender: "tester",
      body: "hi",
      network_id: network.id,
      meta: %{}
    }

    attrs =
      cond do
        v = Keyword.get(opts, :visitor) -> Map.put(base, :visitor_id, v.id)
        u = Keyword.get(opts, :user) -> Map.put(base, :user_id, u.id)
      end

    {:ok, msg} =
      %Grappa.Scrollback.Message{}
      |> Grappa.Scrollback.Message.changeset(attrs)
      |> Repo.insert()

    msg
  end
end
