defmodule Grappa.Scrollback.MessageTest do
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Message

  # Phase 2 (sub-task 2e): user_id is binary_id (UUID), network_id is
  # an integer FK. assoc_constraint on both is DB-level so it doesn't
  # fire here — these tests stay sandbox-free and exercise only the
  # `cast/3` + `validate_required/2` shape.
  @valid_attrs %{
    user_id: Ecto.UUID.generate(),
    network_id: 1,
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
      for {field, error_key} <- [
            # B5.4 M-pers-2: user_id absence triggers the XOR validator,
            # which now attaches its error to the synthetic :subject key
            # (not :user_id). All other fields still report their own key.
            {:user_id, :subject},
            {:network_id, :network_id},
            {:channel, :channel},
            {:server_time, :server_time},
            {:kind, :kind},
            {:sender, :sender},
            {:body, :body}
          ] do
        attrs = Map.delete(@valid_attrs, field)
        cs = Message.changeset(%Message{}, attrs)
        refute cs.valid?, "expected missing #{field} to invalidate the changeset"

        assert cs.errors[error_key] != nil,
               "expected missing #{field} to surface an error on #{error_key}"
      end
    end
  end
end
