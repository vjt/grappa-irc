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

  describe "content_kinds/0" do
    test "is the human-content subset [:privmsg, :notice, :action]" do
      assert Message.content_kinds() == [:privmsg, :notice, :action]
    end

    test "every content kind is a valid schema kind (subset of kinds/0)" do
      for k <- Message.content_kinds() do
        assert k in Message.kinds(), "#{inspect(k)} is not a valid Message kind"
      end
    end

    test "content kinds are exactly the dm-eligible kinds" do
      # S17 — ties the @dm_with_eligible_kinds derivation back to the
      # SSOT: every content kind accepts a dm_with peer, and every
      # non-content kind rejects one (channel-scope discipline).
      for k <- Message.content_kinds() do
        cs = Message.changeset(%Message{}, Map.merge(@valid_attrs, %{kind: k, dm_with: "alice"}))
        assert cs.valid?, "expected content kind #{inspect(k)} to accept dm_with"
      end

      for k <- Message.kinds(), k not in Message.content_kinds() do
        attrs = Map.merge(@valid_attrs, %{kind: k, dm_with: "alice", body: "x"})
        cs = Message.changeset(%Message{}, attrs)

        assert cs.errors[:dm_with] != nil,
               "expected non-content kind #{inspect(k)} to reject dm_with"
      end
    end
  end

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

    # B6.11 HIGH-7 (no-silent-drops 2026-05-14): :server_event is the
    # typed catch-all kind for KILL/WALLOPS/GLOBOPS/ERROR/CHGHOST and
    # vendor verbs. Excluded from `@body_required_kinds` (the
    # verb-name body fallback in EventRouter is belt-and-braces — the
    # validator no longer rejects nil body for this kind). Excluded
    # from `@dm_with_eligible_kinds` (server-emitted events are
    # channel-scoped or $server-scoped, never DM peers).
    test "accepts :server_event kind without body" do
      attrs = @valid_attrs |> Map.put(:kind, :server_event) |> Map.delete(:body)
      cs = Message.changeset(%Message{}, attrs)
      assert cs.valid?, "expected :server_event with nil body to be valid"
      assert cs.changes.kind == :server_event
    end

    test "rejects :server_event kind with dm_with set (channel-scope discipline)" do
      attrs = Map.merge(@valid_attrs, %{kind: :server_event, dm_with: "alice"})
      cs = Message.changeset(%Message{}, attrs)
      refute cs.valid?, "expected :server_event + dm_with to be rejected"
      assert {"may only be set on :privmsg or :action rows", _} = cs.errors[:dm_with]
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

    # C4/DM fix-up: the `:channel` column stores the PRIVMSG target, which
    # for direct messages is a nick rather than a channel-sigil name. The
    # changeset validator was widened to accept both shapes.
    test "accepts a nick-shaped channel (DM scrollback row)" do
      cs = Message.changeset(%Message{}, %{@valid_attrs | channel: "someuser"})
      assert cs.valid?, "expected nick target to produce a valid changeset"
    end

    test "rejects a channel that is neither a valid channel nor a valid nick" do
      cs = Message.changeset(%Message{}, %{@valid_attrs | channel: "123bad"})
      refute cs.valid?
      assert {"is not a valid IRC identifier", _} = cs.errors[:channel]
    end

    # BUG2 fix-up: "$server" is the synthetic channel for server-origin NOTICEs
    # and MOTD lines. It does not begin with a channel-sigil character and is not
    # a valid IRC nick — the changeset validator must accept it explicitly so
    # EventRouter can persist server-window rows without a changeset rejection.
    test "accepts the $server synthetic channel (server-messages window)" do
      cs =
        Message.changeset(%Message{}, %{
          @valid_attrs
          | channel: "$server",
            kind: :notice,
            sender: "irc.azzurra.chat",
            body: "Welcome to the server"
        })

      assert cs.valid?, "expected $server synthetic to produce a valid changeset"
    end
  end
end
