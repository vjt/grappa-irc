defmodule Grappa.Scrollback.MessageTest do
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Message

  @valid_attrs %{
    network_id: "azzurra",
    channel: "#sniffo",
    server_time: 1_777_804_800_000,
    kind: :privmsg,
    sender: "vjt",
    body: "ciao"
  }

  describe "changeset/2" do
    test "valid for fully-populated attrs" do
      cs = Message.changeset(%Message{}, @valid_attrs)
      assert cs.valid?
      assert cs.changes.kind == :privmsg
    end

    test "accepts each known kind" do
      for kind <- [:privmsg, :notice, :action] do
        cs = Message.changeset(%Message{}, %{@valid_attrs | kind: kind})
        assert cs.valid?, "expected #{inspect(kind)} to be a valid kind"
        assert cs.changes.kind == kind
      end
    end

    test "rejects an unknown kind" do
      cs = Message.changeset(%Message{}, %{@valid_attrs | kind: :ctcp})
      refute cs.valid?
      assert {"is invalid", _} = cs.errors[:kind]
    end

    test "accepts a string matching a known kind name (Ecto.Enum casts to atom)" do
      cs = Message.changeset(%Message{}, %{@valid_attrs | kind: "privmsg"})
      assert cs.valid?
      assert cs.changes.kind == :privmsg
    end

    test "rejects missing required fields" do
      for field <- [:network_id, :channel, :server_time, :kind, :sender, :body] do
        attrs = Map.delete(@valid_attrs, field)
        cs = Message.changeset(%Message{}, attrs)
        refute cs.valid?, "expected missing #{field} to invalidate the changeset"
        assert cs.errors[field] != nil
      end
    end
  end
end
