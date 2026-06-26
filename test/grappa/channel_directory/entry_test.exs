defmodule Grappa.ChannelDirectory.EntryTest do
  use Grappa.DataCase, async: true

  alias Grappa.ChannelDirectory.Entry

  describe "changeset/2" do
    test "valid with a user subject" do
      cs =
        Entry.changeset(%Entry{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          name: "#grappa",
          topic: "hi",
          user_count: 42,
          captured_at: nil
        })

      assert cs.valid?
    end

    test "valid with a visitor subject" do
      cs =
        Entry.changeset(%Entry{}, %{
          visitor_id: Ecto.UUID.generate(),
          network_id: 1,
          name: "#grappa",
          topic: "hi",
          user_count: 5,
          captured_at: nil
        })

      assert cs.valid?
    end

    test "requires name + network_id + user_count" do
      cs = Entry.changeset(%Entry{}, %{user_id: Ecto.UUID.generate()})
      refute cs.valid?
      assert %{network_id: _, name: _, user_count: _} = errors_on(cs)
    end

    test "rejects setting both user_id and visitor_id (subject XOR)" do
      cs =
        Entry.changeset(%Entry{}, %{
          user_id: Ecto.UUID.generate(),
          visitor_id: Ecto.UUID.generate(),
          network_id: 1,
          name: "#x",
          user_count: 0
        })

      refute cs.valid?
      assert %{subject: _} = errors_on(cs)
    end

    test "rejects neither subject" do
      cs = Entry.changeset(%Entry{}, %{network_id: 1, name: "#x", user_count: 0})
      refute cs.valid?
      assert %{subject: _} = errors_on(cs)
    end
  end
end
