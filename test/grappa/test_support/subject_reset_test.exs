defmodule Grappa.TestSupport.SubjectResetTest do
  @moduledoc """
  Unit tests for `Grappa.TestSupport.SubjectReset` — the compile-gated
  orchestrator wired into `POST /admin/test/reset-subject` (T9).

  Only the DB-drain + user-not-found paths are exercised here. The
  Session.Server respawn branch is gated behind a `:connected`
  credential and requires a real (or faked) IRC upstream — covered by
  the e2e pilot in T12-T14. The setup pins `connection_state: :parked`
  so the respawn branch is skipped.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Notify, QueryWindows, ReadCursor, ScrollbackHelpers, UserSettings}
  alias Grappa.TestSupport.SubjectReset

  defp insert_message(subject_attrs, network_id, channel, server_time, body \\ "msg") do
    attrs =
      Map.merge(subject_attrs, %{
        network_id: network_id,
        channel: channel,
        server_time: server_time,
        kind: :privmsg,
        sender: "vjt-grappa",
        body: body
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  setup do
    user = user_fixture(name: "vjt-test-reset-#{System.unique_integer([:positive])}")
    network = network_fixture()

    # Bind a :parked credential so the orchestrator's respawn branch
    # is skipped (unit test has no real IRC upstream).
    {:ok, _} =
      Grappa.Networks.Credentials.bind_credential(user, network, %{
        nick: "vjt-grappa",
        auth_method: :none,
        autojoin_channels: ["#bofh"],
        connection_state: :parked
      })

    msg = insert_message(%{user_id: user.id}, network.id, "#bofh", 1)

    {:ok, _} = ReadCursor.set({:user, user.id}, network.id, "#bofh", msg.id)
    {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "alice", user.name)
    {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])
    # #364 S1 — a watch entry must be drained too (else it re-arms the respawn).
    {:ok, _} = Notify.add({:user, user.id}, network.id, ["watched-nick"], user.name)

    %{user: user, network: network, message: msg}
  end

  describe "reset!/2" do
    test "drains all mutable DB surfaces for the user", %{user: user, network: network} do
      assert :ok = SubjectReset.reset!(user.name, %{})

      assert ReadCursor.get({:user, user.id}, network.id, "#bofh") == nil
      assert QueryWindows.list_for_subject({:user, user.id}) == %{}
      assert UserSettings.get_highlight_patterns({:user, user.id}) == []
      # #364 S1 — the watch list is drained (was left behind pre-fix,
      # re-arming MONITOR/WATCH on the respawn and flaking later specs).
      assert Notify.list({:user, user.id}, network.id) == []
    end

    test "does not touch other users", %{user: user, network: network} do
      other = user_fixture(name: "other-test-reset-#{System.unique_integer([:positive])}")

      other_msg =
        insert_message(%{user_id: other.id}, network.id, "#bofh", 2, "other-body")

      {:ok, _} = ReadCursor.set({:user, other.id}, network.id, "#bofh", other_msg.id)
      {:ok, _} = UserSettings.set_highlight_patterns({:user, other.id}, ["keep-me"])
      {:ok, _} = Notify.add({:user, other.id}, network.id, ["other-watched"], other.name)

      assert :ok = SubjectReset.reset!(user.name, %{})

      other_cursor = ReadCursor.get({:user, other.id}, network.id, "#bofh")
      assert other_cursor != nil
      assert other_cursor.last_read_message_id == other_msg.id
      assert UserSettings.get_highlight_patterns({:user, other.id}) == ["keep-me"]
      # #364 S1 — the drain is user-scoped: the other user's watch list stays.
      assert [%{nick: "other-watched"}] = Notify.list({:user, other.id}, network.id)
    end

    test "returns {:error, :user_not_found} for unknown user_name" do
      assert {:error, :user_not_found} =
               SubjectReset.reset!(
                 "ghost-nonexistent-user-#{System.unique_integer([:positive])}",
                 %{}
               )
    end
  end
end
