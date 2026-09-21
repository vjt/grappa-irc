defmodule Grappa.Scrollback.MessageTest do
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Message

  # issue 2176 — `Message.structural_row?/1` is a query macro (the shared Ecto
  # fragment for the structural-mode exemption).
  require Message

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

  describe "notify_kinds/0 (#395)" do
    test "is the notify-worthy subset [:privmsg, :action]" do
      assert Message.notify_kinds() == [:privmsg, :action]
    end

    test "notify kinds are a subset of content kinds BY CONSTRUCTION" do
      # #395 core invariant: the badge/push kind set can NEVER exceed the
      # unread-content set. Both derive from the ONE projection declaration,
      # so `notify_kinds -- content_kinds` is empty by construction — badge
      # ⊆ unread structurally, not because two hand-maintained lists agree.
      assert Message.notify_kinds() -- Message.content_kinds() == [],
             "notify_kinds must be a subset of content_kinds"
    end

    test ":notice counts as unread content but is NOT notify-worthy" do
      # #395 decided behaviour (vjt): services chatter (NickServ/ChanServ/
      # bots) is the dominant NOTICE shape — it counts as an unread message
      # but must never raise a badge or a push.
      assert :notice in Message.content_kinds()
      refute :notice in Message.notify_kinds()
    end

    test "every notify kind is a valid schema kind (subset of kinds/0)" do
      for k <- Message.notify_kinds() do
        assert k in Message.kinds(), "#{inspect(k)} is not a valid Message kind"
      end
    end
  end

  describe "suppressed_presence_kinds/0 (#458, widened by #1262)" do
    test "is the noise subset [:join, :part, :quit, :nick_change, :mode]" do
      # Mirror order of cic's SUPPRESSED_PRESENCE_KINDS
      # (cicchetto/src/lib/presenceFilter.ts) — the server filter and the
      # client render-filter must agree on exactly which kinds are noise.
      # `:mode` joined the set in #1262 when vjt withdrew #458's
      # "mode carries operator-relevant signal" rule; the parity test in
      # `presence_filter_test.exs` is what actually holds the two sides equal.
      assert Message.suppressed_presence_kinds() == [:join, :part, :quit, :nick_change, :mode]
    end

    test "every suppressed kind is a valid schema kind (subset of kinds/0)" do
      for k <- Message.suppressed_presence_kinds() do
        assert k in Message.kinds(), "#{inspect(k)} is not a valid Message kind"
      end
    end

    test "suppressed kinds are DISJOINT from content kinds (never suppress content)" do
      # The core safety invariant: presence filtering must never drop a
      # human-content row (:privmsg/:notice/:action). If these sets ever
      # overlapped, hiding presence would silently swallow real messages.
      assert Message.suppressed_presence_kinds() -- Message.content_kinds() ==
               Message.suppressed_presence_kinds()
    end

    test "the remaining control kinds (topic/kick/server_event) are NOT suppressed" do
      # `:topic`, `:kick` and `:server_event` are presence/control but are not
      # churn: they stay visible while a channel is denoised. `:mode` used to
      # be in this list under #458 and was moved out by #1262 — see the
      # sibling test below.
      for k <- [:topic, :kick, :server_event] do
        refute k in Message.suppressed_presence_kinds(),
               "#{inspect(k)} must NOT be in the suppressed set"
      end
    end

    test "#1262 — :mode IS suppressed (the #458 carve-out is withdrawn)" do
      # vjt, 2026-08-13: `:mode` may go into the suppressed set as a plain
      # fifth kind. The accepted cost was that +b/+k/+l/+m/+i transitions were
      # omitted from the fetch too while the channel is denoised — see
      # DESIGN_NOTES.
      #
      # issue 2176 paid that cost off and the kind STAYS here, deliberately: a
      # `+o` is still churn, and the narrowing is the per-row exemption
      # `structural_meta_key/0`, not a shorter list. An implementation that
      # narrowed by pulling `:mode` back OUT would un-fold the op churn this
      # set exists for.
      assert :mode in Message.suppressed_presence_kinds()
    end
  end

  # issue 2176 — the per-ROW exemption from the set above. The suppressed set
  # answers "is this KIND churn?" and for `:mode` the honest answer needs the
  # LETTERS, so the server classifies once at persist time and tags the row.
  describe "structural_meta_key/0 (issue 2176)" do
    test "is :structural" do
      assert Message.structural_meta_key() == :structural
    end

    test "issue 2228 B — the tag is ALSO a real column, derived from the meta key" do
      # The read predicate moved off `json_extract(meta, '$.structural')` and
      # onto this column, because a JSON reach into `meta` touches a value no
      # index carries and costs the aggregate its COVERING plan (measured:
      # `USING INDEX` vs `USING COVERING INDEX`, ~2.8x on a 403,907-row copy of
      # prod). The column is DERIVED, never a second input: `meta` stays the
      # writer's and cic's channel for the tag, and the changeset is the ONE
      # place the two are tied together, so there is no dual-write for a caller
      # to get wrong.
      assert :structural in Message.__schema__(:fields)
      assert Message.__schema__(:type, :structural) == :boolean
    end

    test "issue 2228 B — a tagged meta produces structural: true on the changeset" do
      cs =
        Message.changeset(%Message{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          channel: "#c",
          server_time: 1,
          kind: :mode,
          sender: "op",
          body: nil,
          meta: %{Message.structural_meta_key() => true, modes: "+b", args: ["troll!*@*"]}
        })

      assert Ecto.Changeset.get_field(cs, :structural) == true
    end

    test "issue 2228 B — an untagged meta produces structural: false, never nil" do
      # NOT NULL in the DB, so a nil here is a constraint error at insert; and
      # a three-valued column would put `NULL` back into the predicate the
      # column exists to make cheap.
      cs =
        Message.changeset(%Message{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          channel: "#c",
          server_time: 1,
          kind: :mode,
          sender: "op",
          body: nil,
          meta: %{modes: "+o", args: ["alice"]}
        })

      assert Ecto.Changeset.get_field(cs, :structural) == false
    end

    test "is an allowlisted meta key — otherwise the tagged row is REJECTED" do
      # `Grappa.Scrollback.Meta` is strict IN: `cast/1` and `dump/1` refuse a
      # key outside `@known_keys`. A writer tagging a row with a key that is
      # not on the list does not degrade to an untagged row — the whole
      # changeset fails and the transcript line is lost. This is the one
      # assertion standing between the tag and that outcome.
      assert Message.structural_meta_key() in Grappa.Scrollback.Meta.known_keys()
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

    test "folds a nick-shaped channel (DM window KEY) at the persist boundary (#537)" do
      # #537 — the `:channel` column is the WINDOW KEY. A DM key is a peer
      # nick; the sigil-gated canonical_channel/1 left it RAW, so the write
      # path forked one DM window into one row PER CASING while the read
      # path resolved them case-insensitively — the #532-family ghost, one
      # table out. The KEY must fold (display case is read from `dm_with`,
      # never from the key). `canonical_target/1` is the fold at every
      # identifier boundary (vjt ruling #537: fold on EVERY identifier).
      cs = Message.changeset(%Message{}, %{@valid_attrs | channel: "PeerNick"})
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :channel) == "peernick"

      # ASCII-only (#525 pin): bracket/brace variants stay distinct keys.
      a = Message.changeset(%Message{}, %{@valid_attrs | channel: "foo[1]"})
      b = Message.changeset(%Message{}, %{@valid_attrs | channel: "foo{1}"})
      refute Ecto.Changeset.get_change(a, :channel) == Ecto.Changeset.get_change(b, :channel)
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
