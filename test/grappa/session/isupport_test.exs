defmodule Grappa.Session.ISupportTest do
  @moduledoc """
  Tests for `Grappa.Session.ISupport` — the per-network channel-mode
  capability table parsed from 005 RPL_ISUPPORT CHANMODES= + PREFIX=.

  Covers:
  - `default/0` — the pre-005 Bahamut/Azzurra seed (the values the
    hardcoded `@user_mode_prefixes` / `@channel_modes_with_param`
    constants used to carry).
  - `merge_isupport/2` — folds CHANMODES + PREFIX tokens off a 005
    param list into an existing capability table (unknown tokens
    ignored, absent tokens preserved).
  - `takes_param?/3` — whether a channel mode consumes an argument when
    applied with the given sign (RFC 2811 type A/B always; type C on +
    only; type D never).
  - `list_mode?/2` (#1249) — whether a channel mode is CHANMODES type A
    (a per-channel list: bans, exceptions), which the mode-set walkers
    must consume the param of but never record as a channel flag.
  - `user_prefix/2` — mode letter → sigil for per-user (membership)
    modes, or `:error` for channel-level modes.
  - `structural_mode_token?/2` (issue 2176) — whether a MODE token says
    anything about the CHANNEL rather than about a member's status
    prefix, the write-time denoise classification.
  - `presence_mechanism/1` (#247) — MONITOR=/WATCH= token capture and
    the monitor-over-watch mechanism pick for the `/notify` arm.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.ISupport

  # The capability table minus the #1255 verbatim archive — the projection
  # every consumer in-tree actually reads. Used where a test means "the
  # typed facts did not move", which is no longer the same as "the table
  # did not move".
  defp typed(isupport), do: Map.drop(isupport, [:raw])

  describe "default/0" do
    test "seeds the pre-005 Bahamut/Azzurra prefix + param tables" do
      d = ISupport.default()

      # PREFIX=(ohv)@%+ — the old @user_mode_prefixes constant.
      assert ISupport.user_prefix(d, "o") == {:ok, "@"}
      assert ISupport.user_prefix(d, "h") == {:ok, "%"}
      assert ISupport.user_prefix(d, "v") == {:ok, "+"}
      assert ISupport.user_prefix(d, "n") == :error

      # CHANMODES param modes — the old @channel_modes_with_param set
      # (b,e,I list-modes + k always-param + l set-only-param).
      for {mode, sign} <- [{"b", :add}, {"e", :add}, {"I", :add}, {"k", :add}] do
        assert ISupport.takes_param?(d, mode, sign),
               "expected #{mode} to take a param on +"
      end

      # l (type C) takes a param on + but NOT on -.
      assert ISupport.takes_param?(d, "l", :add)
      refute ISupport.takes_param?(d, "l", :remove)

      # Flag modes (type D) never take a param.
      for mode <- ["n", "t", "m", "s", "i", "p", "r"] do
        refute ISupport.takes_param?(d, mode, :add),
               "expected flag mode #{mode} to take no param"
      end
    end
  end

  describe "merge_isupport/2" do
    test "parses CHANMODES + PREFIX tokens from a 005 param list" do
      params = [
        "grappa-test",
        "CHANMODES=beI,k,l,imnpstrDdRcC",
        "PREFIX=(qaohv)~&@%+",
        "MODES=4",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())

      # New PREFIX brings founder/admin sigils.
      assert ISupport.user_prefix(isupport, "q") == {:ok, "~"}
      assert ISupport.user_prefix(isupport, "a") == {:ok, "&"}
      assert ISupport.user_prefix(isupport, "o") == {:ok, "@"}
      assert ISupport.user_prefix(isupport, "v") == {:ok, "+"}

      # CHANMODES type A/B/C still take params; new type-D flags do not.
      assert ISupport.takes_param?(isupport, "b", :add)
      assert ISupport.takes_param?(isupport, "k", :add)
      assert ISupport.takes_param?(isupport, "l", :add)
      refute ISupport.takes_param?(isupport, "l", :remove)
      refute ISupport.takes_param?(isupport, "D", :add)
      refute ISupport.takes_param?(isupport, "R", :add)
    end

    # These three compare the TYPED projection, not the whole table: since
    # #1255 the verbatim `:raw` archive records every advertised token,
    # including ones with no typed consumer and ones the typed parser
    # rejected, so a table that "did not change" still grows an archive
    # entry. `raw` has its own describe below.
    test "preserves the current table when tokens are absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      d = ISupport.default()

      assert typed(ISupport.merge_isupport(params, d)) == typed(d)
    end

    test "ignores a malformed CHANMODES token (wrong class count)" do
      # A CHANMODES with fewer than 4 comma-classes is malformed; keep
      # the prior table rather than corrupting param-arity classification.
      params = ["grappa-test", "CHANMODES=beI,k"]
      d = ISupport.default()

      assert typed(ISupport.merge_isupport(params, d)) == typed(d)
    end

    test "ignores a malformed PREFIX token (unbalanced modes/sigils)" do
      params = ["grappa-test", "PREFIX=(ohv)@%"]
      d = ISupport.default()

      assert typed(ISupport.merge_isupport(params, d)) == typed(d)
    end
  end

  # #1255 — the merge contract, pinned. Both docstrings (this module's
  # `merge_isupport/2` and the `Session.Server` 005 handler comment) used to
  # claim "only the first occurrence is honoured", and neither the reduce nor
  # any clause has ever implemented that: every clause writes unconditionally.
  # Last-wins is ALSO what draft-brocklesby-irc-isupport-03 §2 requires ("the
  # server should merely re-advertise the parameter with the new value"), so
  # the code was right and the prose was a spec violation on paper. These
  # tests are the executable form of the corrected contract — a future reader
  # tempted to add the "already set" guard the old docstring described has to
  # go through them.
  describe "merge_isupport/2 merge semantics (#1255)" do
    test "a token repeated within ONE 005 line honours the LAST occurrence" do
      params = [
        "grappa-test",
        "CHANMODES=beI,k,l,imnpst",
        "CHANMODES=b,k,l,imnpst",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())

      # The SECOND advertisement narrowed type A to `b` alone: `e` and `I`
      # no longer take a param. A first-wins reduce would still classify
      # them as list modes.
      assert ISupport.takes_param?(isupport, "b", :add)
      refute ISupport.takes_param?(isupport, "e", :add)
      refute ISupport.takes_param?(isupport, "I", :add)
    end

    test "a re-advertisement on a LATER 005 line overwrites the earlier value" do
      # A 005 burst arrives in several lines, and the draft's stated way to
      # CHANGE a value is to re-advertise it — no negation required. Folding
      # line 2 onto the table line 1 produced must therefore take the new
      # value, not defend the old one.
      isupport =
        ISupport.default()
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(ov)@+"], &1))
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], &1))

      assert ISupport.user_prefix(isupport, "q") == {:ok, "~"}
      assert ISupport.user_prefix(isupport, "v") == {:ok, "+"}
    end

    # #1302 — PREFIX advertises its letters highest-rank-first, and that
    # ORDER is a fact of its own: `Map.new/1` throws it away, so a consumer
    # holding only the map cannot tell a founder from a voice. The order is
    # captured from the same parse that builds the map — one zip, two
    # projections — so the two cannot drift apart.
    test "captures the ADVERTISED rank order, which the map itself cannot carry" do
      isupport =
        ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], ISupport.default())

      assert ISupport.prefix_order(isupport) == ["q", "a", "o", "h", "v"]

      # The map from the SAME token still resolves every letter — a lookup
      # was never the broken part...
      assert ISupport.user_prefix(isupport, "q") == {:ok, "~"}
      assert ISupport.user_prefix(isupport, "v") == {:ok, "+"}

      # ...but its own key order is NOT the advertised one, which is the
      # whole reason the order has to travel separately.
      refute Map.keys(isupport.prefix) == ["q", "a", "o", "h", "v"]
    end

    test "a re-advertised PREFIX replaces the rank order too" do
      # The order must follow the same last-wins rule as the map beside it:
      # a table left holding line 1's order and line 2's map would rank
      # letters that are no longer in it.
      isupport =
        ISupport.default()
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(ov)@+"], &1))
        |> then(&ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], &1))

      assert ISupport.prefix_order(isupport) == ["q", "a", "o", "h", "v"]
    end

    test "a malformed PREFIX leaves the previous rank order standing" do
      # Same posture as the map: an unbalanced token is ignored rather than
      # blanking the table, so a misbehaving server cannot strip rank.
      isupport =
        ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@"], ISupport.default())

      assert ISupport.prefix_order(isupport) == ISupport.default_prefix_order()
    end
  end

  describe "prefix_order/1" do
    test "pre-005 default is the bahamut/Azzurra order" do
      assert ISupport.prefix_order(ISupport.default()) == ["o", "h", "v"]
      assert ISupport.default_prefix_order() == ["o", "h", "v"]
    end

    test "a table predating the field reads the default instead of raising" do
      # Hot-reload safety, exactly as `statusmsg/1` has it: a live
      # Session.Server state seeded before this field exists and read after
      # the new module is loaded must degrade, not KeyError.
      legacy = Map.delete(ISupport.default(), :prefix_order)

      assert ISupport.prefix_order(legacy) == ISupport.default_prefix_order()
    end
  end

  describe "sigils/1" do
    test "pre-005 default is the bahamut/Azzurra sigil run, highest rank first" do
      assert ISupport.sigils(ISupport.default()) == ["@", "%", "+"]
    end

    test "a PREFIX-rich network yields its whole sigil run in ADVERTISED order" do
      # issue 1999 — the set every membership-sigil consumer must derive from,
      # instead of the `@ % +` triple three call sites hardcoded. The order is
      # `prefix_order`'s, i.e. the 005's, so index 0 is genuinely the top rank.
      isupport =
        ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], ISupport.default())

      assert ISupport.sigils(isupport) == ["~", "&", "@", "%", "+"]
    end

    test "the run is NOT the map's value order" do
      # The sibling guard to `prefix_order/1`'s own: `Map.values/1` on a small
      # map comes back alphabetical BY LETTER, which on `(qaohv)` puts `o`
      # (`@`) in the middle — the exact mis-rank #1302 fixed in `editorSigils`.
      # Deriving the run from the map instead of the order would reintroduce it.
      isupport =
        ISupport.merge_isupport(["grappa-test", "PREFIX=(qaohv)~&@%+"], ISupport.default())

      refute ISupport.sigils(isupport) == Map.values(isupport.prefix)
    end

    test "a table predating either field reads the defaults instead of raising" do
      # Same hot-reload contract as `prefix_order/1` and `statusmsg/1`: a live
      # Session.Server state seeded before these fields existed, read after the
      # new module loads, must DEGRADE to bahamut rather than KeyError — and
      # must not degrade to `[]`, which would disable sigil stripping entirely.
      legacy = Map.drop(ISupport.default(), [:prefix_order, :prefix])

      assert ISupport.sigils(legacy) == ["@", "%", "+"]
    end

    test "a letter with no sigil in the map is skipped, not rendered as nil" do
      # The two projections come from one parse and cannot disagree today, but
      # the accessor is total by construction rather than by that invariant:
      # a half-written table drops the orphan letter instead of emitting a nil
      # that would then be compared against a binary downstream.
      orphan = %{ISupport.default() | prefix_order: ["o", "q", "v"]}

      assert ISupport.sigils(orphan) == ["@", "+"]
    end
  end

  describe "takes_param?/3 type-C sign sensitivity" do
    test "type C consumes a param on + but not on -" do
      # l is the canonical type-C mode (+l 42 sets a limit; -l clears it
      # with no argument). A parser that consumes an arg on -l would
      # misalign the remaining args for a following param mode.
      d = ISupport.default()
      assert ISupport.takes_param?(d, "l", :add)
      refute ISupport.takes_param?(d, "l", :remove)
    end
  end

  # #1249 — CHANMODES type A is a per-channel LIST (bans, exceptions), not a
  # channel flag: the letter never belongs in the channel's mode set and an
  # ircd never reports it in 324 RPL_CHANNELMODEIS. `takes_param?/3` already
  # reads the same table for ARITY; this is the CLASS question, and the
  # walkers need it to drop the letter while still consuming its argument.
  describe "list_mode?/2 (#1249)" do
    test "the default table classifies b/e/I as list modes and flags as not" do
      d = ISupport.default()

      for mode <- ["b", "e", "I"] do
        assert ISupport.list_mode?(d, mode), "expected #{mode} to be a type-A list mode"
      end

      # Type B/C/D are channel state, not lists — including `k`, which takes
      # a param on both signs exactly like a type A does.
      for mode <- ["k", "l", "n", "t", "m", "s", "i"] do
        refute ISupport.list_mode?(d, mode), "expected #{mode} NOT to be a type-A list mode"
      end
    end

    test "the type-A letter set is per-network, read from the advertised CHANMODES" do
      # bahamut/Azzurra has no +e/+I and does have a `z` restrict list;
      # solanum advertises `q`. A hardcoded ["b","e","I"] would mis-class
      # both networks — the answer must come from the 005 table.
      bahamut =
        ISupport.merge_isupport(["s", "CHANMODES=bz,k,l,imnpst"], ISupport.default())

      assert ISupport.list_mode?(bahamut, "b")
      assert ISupport.list_mode?(bahamut, "z")
      refute ISupport.list_mode?(bahamut, "e")
      refute ISupport.list_mode?(bahamut, "I")

      solanum =
        ISupport.merge_isupport(["s", "CHANMODES=eIbq,k,flj,CFLMPQScgimnprstz"], ISupport.default())

      for mode <- ["e", "I", "b", "q"] do
        assert ISupport.list_mode?(solanum, mode)
      end

      refute ISupport.list_mode?(solanum, "z")
    end
  end

  # issue 2176 — the write-time denoise classification. A denoised channel
  # folds the status-prefix churn (`+o`/`+v`) and must NOT fold what changes
  # the channel (`+b`/`+k`/`+l`/…). The letter split is derived from this
  # network's own PREFIX table, never from a constant.
  describe "structural_mode_token?/2 (issue 2176)" do
    test "a status-prefix-only token is CHURN on the default table" do
      d = ISupport.default()

      for token <- ["+o", "-o", "+v", "-v", "+h", "+ov", "-ov", "+o-v"] do
        refute ISupport.structural_mode_token?(d, token),
               "expected #{token} to classify as churn (status prefixes only)"
      end
    end

    test "anything that changes the channel is STRUCTURAL" do
      d = ISupport.default()

      # The set the issue names, plus the two list modes the default table
      # advertises beyond `b`.
      for token <- ["+b", "-b", "+k", "+l", "+m", "+i", "+t", "+n", "+s", "+e", "+I"] do
        assert ISupport.structural_mode_token?(d, token),
               "expected #{token} to classify as structural (it changes the channel)"
      end
    end

    test "a MIXED token is structural if ANY letter is — showing it is the safe failure" do
      d = ISupport.default()

      # `MODE #chan +ob nick mask!*@*` — the op grade must not buy the ban
      # invisibility.
      assert ISupport.structural_mode_token?(d, "+ob")
      assert ISupport.structural_mode_token?(d, "+bo")
      assert ISupport.structural_mode_token?(d, "+o-b")
      assert ISupport.structural_mode_token?(d, "-o+b")
    end

    test "the churn letters are PER-NETWORK, read from the advertised PREFIX" do
      # A network advertising founder/admin grades: `q` and `a` are status
      # prefixes THERE, so they are churn there — and `+q` on a network that
      # does NOT advertise them (bahamut/Azzurra's default `(ohv)`) is a
      # channel mode, so it is structural. A hardcoded ~w[o v h] would call
      # the first structural and both networks would be wrong one way each.
      solanum =
        ISupport.merge_isupport(["s", "PREFIX=(qaohv)~&@%+"], ISupport.default())

      refute ISupport.structural_mode_token?(solanum, "+q")
      refute ISupport.structural_mode_token?(solanum, "+a")
      refute ISupport.structural_mode_token?(solanum, "+qaohv")
      assert ISupport.structural_mode_token?(ISupport.default(), "+q")
      assert ISupport.structural_mode_token?(ISupport.default(), "+a")
    end

    test "a token with no letters states nothing about the channel — not structural" do
      d = ISupport.default()

      refute ISupport.structural_mode_token?(d, "")
      refute ISupport.structural_mode_token?(d, "+")
      refute ISupport.structural_mode_token?(d, "+-")
    end

    test "a MALFORMED token falls on the structural side (safe failure)" do
      # #878 persists the transcript row for a token whose derived state it
      # refuses. Those bytes are not prefix letters, so the row shows — which
      # is the right way round: a line nobody could parse is not churn anyone
      # should be hiding.
      d = ISupport.default()

      assert ISupport.structural_mode_token?(d, "+o!")
      assert ISupport.structural_mode_token?(d, "garbage")
      assert ISupport.structural_mode_token?(d, "+é")
    end
  end

  # #218 — STATUSMSG is the ISUPPORT token listing which membership PREFIX
  # sigils may prefix a message target (`NOTICE @#chan`, `PRIVMSG +#chan`).
  # It's the source of truth for EventRouter's statusmsg-target strip, so
  # the set is network-advertised (bahamut/Azzurra: `@+`), never hardcoded.
  describe "STATUSMSG (#218)" do
    test "default/0 seeds the bahamut/Azzurra statusmsg sigils (@+)" do
      assert ISupport.statusmsg(ISupport.default()) == ["@", "+"]
      assert ISupport.default_statusmsg() == ["@", "+"]
    end

    test "merge_isupport/2 parses a STATUSMSG= token into the sigil list" do
      params = ["grappa-test", "STATUSMSG=@+", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.statusmsg(isupport) == ["@", "+"]
    end

    test "merge_isupport/2 honours a network that advertises a wider set (@%+)" do
      # A halfop-carrying network (`PREFIX=(ohv)@%+`) may advertise `%` as
      # a statusmsg level too — the set MUST come from the wire, not a
      # hardcoded `@+`.
      params = ["grappa-test", "STATUSMSG=@%+"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.statusmsg(isupport) == ["@", "%", "+"]
    end

    test "merge_isupport/2 preserves the current statusmsg when the token is absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      d = ISupport.default()
      assert ISupport.statusmsg(ISupport.merge_isupport(params, d)) == ISupport.default_statusmsg()
    end

    test "merge_isupport/2 ignores an empty STATUSMSG= token" do
      # A server advertising `STATUSMSG=` with no sigils is malformed;
      # keep the prior set rather than blanking the strip capability.
      params = ["grappa-test", "STATUSMSG="]
      d = ISupport.default()
      assert ISupport.statusmsg(ISupport.merge_isupport(params, d)) == ISupport.default_statusmsg()
    end

    test "statusmsg/1 falls back to the default on a table predating the field (hot-reload safety)" do
      # A live Session.Server state seeded BEFORE this field existed holds
      # an isupport map without `:statusmsg`. A hot code-reload that reads
      # it must NOT KeyError — it defaults to the bahamut set, mirroring
      # the `Map.get(state, :isupport, ISupport.default())` pattern in
      # Session.Server. Cold restart reseeds the full default.
      pre_218 = Map.drop(ISupport.default(), [:statusmsg])
      refute Map.has_key?(pre_218, :statusmsg)
      assert ISupport.statusmsg(pre_218) == ISupport.default_statusmsg()
    end
  end

  # #537 — CASEMAPPING is the ISUPPORT token declaring how the ircd folds
  # identifiers (nicks AND channels): `ascii` (A-Z only — bahamut/Azzurra),
  # `rfc1459` (also folds `[ ] \` → `{ } |` and `~` → `^` — solanum/Libera),
  # `rfc1459-strict` (the bracket trio, NOT `~`). It's the source of truth
  # for the per-network ingress normaliser; an absent or unrecognised token
  # is treated as `ascii` (what #525 built for) so the rest of the server
  # can assume ASCII after the ingress door.
  describe "CASEMAPPING (#537)" do
    test "default/0 seeds :ascii (the absent-token default)" do
      assert ISupport.casemapping(ISupport.default()) == :ascii
    end

    test "merge_isupport/2 parses CASEMAPPING=ascii" do
      params = ["grappa-test", "CASEMAPPING=ascii", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :ascii
    end

    test "merge_isupport/2 parses CASEMAPPING=rfc1459 (solanum/Libera)" do
      params = ["grappa-test", "CASEMAPPING=rfc1459", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :rfc1459
    end

    test "merge_isupport/2 parses CASEMAPPING=rfc1459-strict" do
      params = ["grappa-test", "CASEMAPPING=rfc1459-strict"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.casemapping(isupport) == :rfc1459_strict
    end

    test "merge_isupport/2 falls back to :ascii + logs on an unrecognised value" do
      # A token value we don't model MUST NOT guess a fold table — it
      # degrades to :ascii (the safest: too-lax beats merging distinct
      # identities) and logs so the operator sees the unsupported network.
      import ExUnit.CaptureLog

      log =
        capture_log(fn ->
          isupport =
            ISupport.merge_isupport(["grappa-test", "CASEMAPPING=weird-9000"], ISupport.default())

          assert ISupport.casemapping(isupport) == :ascii
        end)

      assert log =~ "CASEMAPPING"
      assert log =~ "weird-9000"
    end

    test "merge_isupport/2 preserves the current casemapping when the token is absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      rfc = ISupport.merge_isupport(["grappa-test", "CASEMAPPING=rfc1459"], ISupport.default())
      assert ISupport.casemapping(ISupport.merge_isupport(params, rfc)) == :rfc1459
    end

    test "casemapping/1 falls back to :ascii on a table predating the field (hot-reload safety)" do
      # A live Session.Server isupport map seeded before #537 has no
      # :casemapping key; a hot code-reload reading it must default to
      # :ascii, not KeyError. Mirrors statusmsg/1 + presence_mechanism/1.
      pre_537 = Map.drop(ISupport.default(), [:casemapping])
      refute Map.has_key?(pre_537, :casemapping)
      assert ISupport.casemapping(pre_537) == :ascii
    end
  end

  # #1255 — CHANTYPES is the ISUPPORT token listing the sigils that open a
  # CHANNEL name on this network. Everything in the stack open-codes the RFC
  # 2812 set `#&+!` (cic's compose/slashCommands/inviteLink/ScrollbackPane,
  # the server's `Identifier` channel regex), which is why the default IS
  # that set: a network that omits the token must behave exactly as before.
  describe "CHANTYPES (#1255)" do
    test "default/0 seeds the RFC 2812 sigil set the stack already assumes" do
      assert ISupport.chantypes(ISupport.default()) == ["#", "&", "+", "!"]
      assert ISupport.default_chantypes() == ["#", "&", "+", "!"]
    end

    test "merge_isupport/2 narrows to what the network advertises" do
      # bahamut/Azzurra advertises `#&`: `+foo` and `!foo` are NOT channels
      # there, and a client offering them is offering a JOIN that fails.
      params = ["grappa-test", "CHANTYPES=#&", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.chantypes(isupport) == ["#", "&"]
    end

    test "merge_isupport/2 ignores an empty CHANTYPES= token" do
      # A network with no channel sigils at all cannot be addressed; an
      # empty value is malformed, so keep the prior set rather than making
      # every channel name unrecognisable.
      d = ISupport.default()

      assert ISupport.chantypes(ISupport.merge_isupport(["grappa-test", "CHANTYPES="], d)) ==
               ISupport.default_chantypes()
    end

    test "chantypes/1 falls back to the default on a table predating the field" do
      pre_1255 = Map.drop(ISupport.default(), [:chantypes])
      refute Map.has_key?(pre_1255, :chantypes)
      assert ISupport.chantypes(pre_1255) == ISupport.default_chantypes()
    end
  end

  # #1255 — MAXLIST caps how many entries a type-A (list) mode holds. #1251
  # made every advertised list mode queryable from cic, so a client offering
  # a list needs the advertised cap. There is no honest default: pre-005 the
  # stack enforced no cap at all, and inventing one would reject an entry the
  # ircd would have accepted.
  describe "MAXLIST (#1255)" do
    test "default/0 advertises no caps" do
      assert ISupport.maxlist(ISupport.default()) == %{}
    end

    test "merge_isupport/2 parses a shared cap across a run of letters" do
      # `MAXLIST=beI:100` — ONE budget of 100 shared by b, e and I.
      params = ["grappa-test", "MAXLIST=beI:100", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 100, "e" => 100, "I" => 100}
    end

    test "merge_isupport/2 parses per-letter caps" do
      params = ["grappa-test", "MAXLIST=b:60,e:60,I:50"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 60, "e" => 60, "I" => 50}
    end

    test "merge_isupport/2 keeps the parseable entries and drops the malformed ones" do
      # A garbled entry must not cost the caps that parsed: dropping the
      # whole token would silently uncap every list the network DID declare.
      params = ["grappa-test", "MAXLIST=b:60,e:,:50,I:abc,q:0"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.maxlist(isupport) == %{"b" => 60}
    end

    test "merge_isupport/2 ignores a MAXLIST token with nothing parseable" do
      d = ISupport.default()
      seeded = ISupport.merge_isupport(["grappa-test", "MAXLIST=b:60"], d)

      assert ISupport.maxlist(ISupport.merge_isupport(["grappa-test", "MAXLIST=junk"], seeded)) ==
               %{"b" => 60}
    end

    test "maxlist/1 falls back to the empty map on a table predating the field" do
      pre_1255 = Map.drop(ISupport.default(), [:maxlist])
      assert ISupport.maxlist(pre_1255) == %{}
    end
  end

  # #1255 — the advertised length limits. `nil` (not a number) is the
  # pre-005 seed on purpose: today nothing validates length client-side, so
  # a guessed default would start REJECTING input the network accepts. Same
  # posture as #1108's `frame_budget_base` — no honest default, say nothing.
  describe "length limits (#1255)" do
    test "default/0 advertises no length limits" do
      d = ISupport.default()
      assert ISupport.nicklen(d) == nil
      assert ISupport.channellen(d) == nil
      assert ISupport.topiclen(d) == nil
    end

    test "merge_isupport/2 parses NICKLEN, CHANNELLEN and TOPICLEN" do
      params = [
        "grappa-test",
        "NICKLEN=30",
        "CHANNELLEN=200",
        "TOPICLEN=307",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.nicklen(isupport) == 30
      assert ISupport.channellen(isupport) == 200
      assert ISupport.topiclen(isupport) == 307
    end

    test "merge_isupport/2 ignores non-numeric and non-positive limits" do
      # `NICKLEN=0` would reject every nick; `TOPICLEN=abc` is noise. Keep
      # the prior value — an unusable cap is worse than no cap.
      seeded = ISupport.merge_isupport(["grappa-test", "NICKLEN=30"], ISupport.default())

      junk =
        ISupport.merge_isupport(
          ["grappa-test", "NICKLEN=0", "CHANNELLEN=abc", "TOPICLEN="],
          seeded
        )

      assert ISupport.nicklen(junk) == 30
      assert ISupport.channellen(junk) == nil
      assert ISupport.topiclen(junk) == nil
    end

    test "the limit accessors fall back to nil on a table predating the fields" do
      pre_1255 = Map.drop(ISupport.default(), [:nicklen, :channellen, :topiclen])
      assert ISupport.nicklen(pre_1255) == nil
      assert ISupport.channellen(pre_1255) == nil
      assert ISupport.topiclen(pre_1255) == nil
    end
  end

  # #1390 — MODES= and LINELEN= were the last two 005 tokens carrying a
  # SECOND parser: `Session.Server` scanned them into two bare integer state
  # fields while this module archived the very same tokens in `raw`. One 005,
  # two parses, two merge rules. They come home here, so the typed value is a
  # fact of the ISUPPORT table rather than a field of the session process.
  #
  # Unlike the #1255 length limits they carry a protocol DEFAULT (3 / 512)
  # instead of `nil`: `ModeChunker` and `LineSplit` need a usable number
  # before 005 ever arrives, and "advertised as absent" is not a number.
  describe "MODES + LINELEN (#1390)" do
    test "default/0 seeds the values every consumer needs pre-005" do
      d = ISupport.default()
      assert ISupport.modes(d) == 3
      assert ISupport.linelen(d) == 512
    end

    test "merge_isupport/2 parses MODES and LINELEN off a 005 param list" do
      params = [
        "grappa-test",
        "MODES=6",
        "LINELEN=480",
        "are supported by this server"
      ]

      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.modes(isupport) == 6
      assert ISupport.linelen(isupport) == 480
    end

    test "the accessors fall back to the seed on a table predating the fields" do
      # A session hot-reloaded across this change holds an `isupport` map
      # built before the two keys existed — a plain hot reload does not
      # rewrite process state. The accessor must answer the protocol default
      # rather than KeyError. Same contract as the #1255 limits above.
      pre_1390 = Map.drop(ISupport.default(), [:modes, :linelen])
      assert ISupport.modes(pre_1390) == 3
      assert ISupport.linelen(pre_1390) == 512
    end

    test "merge_isupport/2 ignores a non-positive or non-numeric LINELEN" do
      # INVARIANCE, not one of the three changes below: the scanner this
      # replaces already kept the prior value on a malformed LINELEN. The two
      # cases exercise different guards — `LINELEN=0` the positivity one,
      # `LINELEN=abc` the parse one — so they fail independently.
      seeded = ISupport.merge_isupport(["grappa-test", "LINELEN=480"], ISupport.default())

      assert ISupport.linelen(ISupport.merge_isupport(["grappa-test", "LINELEN=0"], seeded)) == 480
      assert ISupport.linelen(ISupport.merge_isupport(["grappa-test", "LINELEN=x"], seeded)) == 480
    end
  end

  # #1390 — three BEHAVIOUR CHANGES, deliberate, not a tidy-up. Unifying the
  # parse FORCED a choice: the scanner and this module did not agree on the
  # same input, so there was no single "current behaviour" to preserve. The
  # tiebreak was least surprise. Each change is bought by its own assertion
  # here, and each reason is recorded in DESIGN_NOTES rather than left to be
  # deduced from the diff.
  describe "MODES + LINELEN — the three behaviour changes (#1390)" do
    test "a MODES repeated within ONE 005 line honours the LAST occurrence" do
      # WAS: `extract_modes_isupport/2` was a `reduce_while` that `:halt`ed on
      # the first parseable hit, so this line yielded 4. A repeated token is
      # draft-brocklesby §2's way to CORRECT a value; ignoring the correction
      # is the worse surprise, and `raw` — the archive the Phase 6 facade
      # reads — already honoured the last one.
      merged = ISupport.merge_isupport(["grappa-test", "MODES=4", "MODES=6"], ISupport.default())
      assert ISupport.modes(merged) == 6
    end

    test "a LINELEN repeated within ONE 005 line honours the LAST occurrence" do
      # Same change on the twin token, asserted separately: the two clauses
      # can regress on their own, and the failure should say which.
      merged =
        ISupport.merge_isupport(["grappa-test", "LINELEN=512", "LINELEN=480"], ISupport.default())

      assert ISupport.linelen(merged) == 480
    end

    test "a malformed MODES leaves the advertised value standing" do
      # WAS: `parse_modes_token/2` answered `{:cont, 3}` on a failed parse —
      # it dropped the advertised value and substituted the hardcoded default,
      # tightening the limit. Its LINELEN twin kept the prior value on the
      # very same input (see the invariance test above): the divergence is the
      # evidence this was a slip, not a contract. An unreadable token must not
      # produce an arbitrary narrower limit.
      seeded = ISupport.merge_isupport(["grappa-test", "MODES=6"], ISupport.default())
      assert ISupport.modes(ISupport.merge_isupport(["grappa-test", "MODES=x"], seeded)) == 6
    end

    test "-MODES reverts to the seed instead of being ignored" do
      # WAS: `"-MODES"` never matched `"MODES=" <> rest`, so a revocation was
      # silently dropped and the advertised value survived until reconnect.
      # §2 negation reverts to the behaviour-if-unspecified, which is
      # `default/0`; `@negatable` records that a parsed token without an entry
      # there is a visible omission rather than a silent one.
      advertised = ISupport.merge_isupport(["grappa-test", "MODES=6"], ISupport.default())
      assert ISupport.modes(advertised) == 6
      assert ISupport.modes(ISupport.merge_isupport(["grappa-test", "-MODES"], advertised)) == 3
    end

    test "-LINELEN reverts to the seed instead of being ignored" do
      advertised = ISupport.merge_isupport(["grappa-test", "LINELEN=480"], ISupport.default())
      assert ISupport.linelen(advertised) == 480

      assert ISupport.linelen(ISupport.merge_isupport(["grappa-test", "-LINELEN"], advertised)) ==
               512
    end
  end

  # #1255 — draft-brocklesby-irc-isupport-03 §2: "-PARAMETER" is "used to
  # negate a previously specified parameter; that is, revert to the
  # behaviour that would occur if the parameter had not been specified".
  # The behaviour-if-unspecified IS `default/0` — never nil, which would be
  # a third state ("advertised as absent") no accessor models.
  describe "-TOKEN negation (#1255)" do
    test "-WATCH revokes a presence mechanism the session was armed for" do
      # The functional case from the issue: services restart, the ircd pulls
      # WATCH mid-session, and /notify keeps arming a mechanism nobody
      # honours until the next reconnect.
      armed = ISupport.merge_isupport(["grappa-test", "WATCH=128"], ISupport.default())
      assert ISupport.presence_mechanism(armed) == {:watch, 128}

      revoked = ISupport.merge_isupport(["grappa-test", "-WATCH"], armed)
      assert ISupport.presence_mechanism(revoked) == :none
    end

    test "-STATUSMSG reverts to the default sigils, not to nil/empty" do
      wide = ISupport.merge_isupport(["grappa-test", "STATUSMSG=@%+"], ISupport.default())
      reverted = ISupport.merge_isupport(["grappa-test", "-STATUSMSG"], wide)
      assert ISupport.statusmsg(reverted) == ISupport.default_statusmsg()
    end

    test "-CHANTYPES reverts to the RFC default set" do
      narrowed = ISupport.merge_isupport(["grappa-test", "CHANTYPES=#"], ISupport.default())
      reverted = ISupport.merge_isupport(["grappa-test", "-CHANTYPES"], narrowed)
      assert ISupport.chantypes(reverted) == ISupport.default_chantypes()
    end

    test "-CASEMAPPING reverts to :ascii" do
      rfc = ISupport.merge_isupport(["grappa-test", "CASEMAPPING=rfc1459"], ISupport.default())
      reverted = ISupport.merge_isupport(["grappa-test", "-CASEMAPPING"], rfc)
      assert ISupport.casemapping(reverted) == ISupport.default_casemapping()
    end

    test "-NICKLEN clears an advertised limit back to unknown" do
      capped = ISupport.merge_isupport(["grappa-test", "NICKLEN=30"], ISupport.default())
      assert ISupport.nicklen(ISupport.merge_isupport(["grappa-test", "-NICKLEN"], capped)) == nil
    end

    test "-CHANMODES reverts the whole capability table to the seed" do
      narrowed =
        ISupport.merge_isupport(["grappa-test", "CHANMODES=b,k,l,imnpst"], ISupport.default())

      reverted = ISupport.merge_isupport(["grappa-test", "-CHANMODES"], narrowed)
      assert ISupport.takes_param?(reverted, "e", :add)
      assert ISupport.takes_param?(reverted, "I", :add)
    end

    test "negation of a token we do not model leaves the table untouched" do
      d = ISupport.default()
      merged = ISupport.merge_isupport(["grappa-test", "-SAFELIST", "-ELIST"], d)
      assert Map.drop(merged, [:raw]) == Map.drop(d, [:raw])
    end

    test "a negation followed by a re-advertisement in the same line ends advertised" do
      # Last-wins applies to the negation clause too — it is just another
      # write. `-NICKLEN NICKLEN=9` leaves the limit at 9.
      capped = ISupport.merge_isupport(["grappa-test", "NICKLEN=30"], ISupport.default())
      params = ["grappa-test", "-NICKLEN", "NICKLEN=9"]
      assert ISupport.nicklen(ISupport.merge_isupport(params, capped)) == 9
    end

    test "a re-advertisement followed by a negation in the same line ends reverted" do
      capped = ISupport.merge_isupport(["grappa-test", "NICKLEN=30"], ISupport.default())
      params = ["grappa-test", "NICKLEN=9", "-NICKLEN"]
      assert ISupport.nicklen(ISupport.merge_isupport(params, capped)) == nil
    end
  end

  # #1255 scope note — the Phase 6 IRCv3 listener facade has to EMIT a 005
  # to a downstream client, and the typed six threw every other token away
  # at ingress. `raw` is the verbatim archive it will translate from. It is
  # server-side only: a bag of IRC tokens on the cic wire would be IRC
  # protocol re-entering the web client through the window (design
  # principle #1), and the facade must translate rather than passthrough —
  # NETWORK/MODES/TARGMAX/LINELEN describe the UPSTREAM, not the connection
  # the downstream client actually holds.
  describe "raw token archive (#1255)" do
    test "default/0 starts with an empty archive" do
      assert ISupport.raw(ISupport.default()) == %{}
    end

    test "archives every advertised token verbatim, valueless ones as true" do
      params = [
        "grappa-test",
        "NETWORK=Azzurra",
        "CHANMODES=beI,k,l,imnpst",
        "SAFELIST",
        "TARGMAX=PRIVMSG:4,NOTICE:4",
        "are supported by this server"
      ]

      raw = ISupport.raw(ISupport.merge_isupport(params, ISupport.default()))

      # Tokens with no typed consumer are kept — that is the entire point.
      assert raw["NETWORK"] == "Azzurra"
      assert raw["TARGMAX"] == "PRIVMSG:4,NOTICE:4"
      assert raw["SAFELIST"] == true
      # Typed tokens are archived too: one 005, two readers, no second parse.
      assert raw["CHANMODES"] == "beI,k,l,imnpst"
    end

    test "the trailing human-readable text is not a token" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      raw = ISupport.raw(ISupport.merge_isupport(params, ISupport.default()))
      assert Map.keys(raw) == ["NETWORK"]
    end

    test "archives a token the typed parser rejected as malformed" do
      # `raw` is an ingress archive, not a validation result: the typed
      # field defends itself (the capability table is untouched) while the
      # facade still sees exactly what the upstream said.
      params = ["grappa-test", "CHANMODES=beI,k"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.raw(isupport)["CHANMODES"] == "beI,k"
      assert ISupport.takes_param?(isupport, "l", :add)
    end

    test "a re-advertisement overwrites the archived value" do
      params = ["grappa-test", "NETWORK=Azzurra", "NETWORK=Freenode"]
      raw = ISupport.raw(ISupport.merge_isupport(params, ISupport.default()))
      assert raw["NETWORK"] == "Freenode"
    end

    test "-TOKEN removes the key from the archive" do
      # §2 negation is "revert to the behaviour that would occur if the
      # parameter had not been specified" — an archive that kept the key
      # would have the facade re-advertise a revoked capability downstream.
      seeded =
        ISupport.merge_isupport(
          ["grappa-test", "SAFELIST", "NETWORK=Azzurra"],
          ISupport.default()
        )

      revoked = ISupport.merge_isupport(["grappa-test", "-SAFELIST"], seeded)
      raw = ISupport.raw(revoked)
      refute Map.has_key?(raw, "SAFELIST")
      assert raw["NETWORK"] == "Azzurra"
    end

    test "raw/1 falls back to the empty archive on a table predating the field" do
      pre_1255 = Map.drop(ISupport.default(), [:raw])
      assert ISupport.raw(pre_1255) == %{}
    end
  end

  # issue 2430 — the network's own name, as a bot's order challenge carries
  # it: the client compares it EXACTLY, so it is the advertised value or
  # nothing, never a guess.
  describe "network/1 (issue 2430)" do
    test "is the advertised NETWORK= value, verbatim" do
      isupport = ISupport.merge_isupport(["grappa-test", "NETWORK=AzzurraNet"], ISupport.default())
      assert ISupport.network(isupport) == "AzzurraNet"
    end

    test "is nil before a 005, and when the network names itself with nothing" do
      assert ISupport.network(ISupport.default()) == nil

      for token <- ["NETWORK=", "NETWORK"] do
        isupport = ISupport.merge_isupport(["grappa-test", token], ISupport.default())
        assert ISupport.network(isupport) == nil, token
      end
    end

    test "-NETWORK takes the name back" do
      seeded = ISupport.merge_isupport(["grappa-test", "NETWORK=Azzurra"], ISupport.default())
      revoked = ISupport.merge_isupport(["grappa-test", "-NETWORK"], seeded)
      assert ISupport.network(revoked) == nil
    end

    test "is nil on a table predating the raw archive" do
      assert ISupport.network(Map.drop(ISupport.default(), [:raw])) == nil
    end
  end

  describe "presence_mechanism/1 (#247)" do
    test "default/0 advertises no presence mechanism (:none pre-005)" do
      assert ISupport.presence_mechanism(ISupport.default()) == :none
    end

    test "MONITOR=<limit> yields {:monitor, limit}" do
      # solanum / Libera shape.
      params = ["grappa-test", "MONITOR=100", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:monitor, 100}
    end

    test "bare MONITOR token yields {:monitor, :unlimited}" do
      params = ["grappa-test", "MONITOR", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:monitor, :unlimited}
    end

    test "WATCH=<limit> yields {:watch, limit}" do
      # bahamut / Azzurra shape.
      params = ["grappa-test", "WATCH=128", "are supported by this server"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == {:watch, 128}
    end

    test "MONITOR wins over WATCH when both are advertised" do
      # Whichever 005 line order the tokens arrive in, MONITOR (the
      # IRCv3 push mechanism) is preferred over legacy WATCH.
      params = ["grappa-test", "WATCH=128", "MONITOR=100"]
      one_line = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(one_line) == {:monitor, 100}

      # Reversed order across two merge passes (multi-line 005).
      two_lines =
        ISupport.default()
        |> then(&ISupport.merge_isupport(["grappa-test", "MONITOR=100"], &1))
        |> then(&ISupport.merge_isupport(["grappa-test", "WATCH=128"], &1))

      assert ISupport.presence_mechanism(two_lines) == {:monitor, 100}
    end

    test "malformed limit values fall back to :unlimited" do
      # `MONITOR=` (empty) and `WATCH=abc` (non-numeric) advertise the
      # mechanism without a parseable limit — arm it, don't reject it.
      empty_monitor = ISupport.merge_isupport(["grappa-test", "MONITOR="], ISupport.default())
      assert ISupport.presence_mechanism(empty_monitor) == {:monitor, :unlimited}

      alpha_watch = ISupport.merge_isupport(["grappa-test", "WATCH=abc"], ISupport.default())
      assert ISupport.presence_mechanism(alpha_watch) == {:watch, :unlimited}
    end

    test "presence_mechanism/1 is :none on a table predating the fields (hot-reload safety)" do
      # Same shape as the statusmsg/1 hot-safety: a live isupport map
      # seeded before #247 has no :monitor/:watch keys and must not
      # KeyError.
      pre_247 = Map.drop(ISupport.default(), [:monitor, :watch])
      assert ISupport.presence_mechanism(pre_247) == :none
    end

    test "WATCH token does not leak into an unrelated token prefix" do
      # `WATCHFOO=1` is NOT a WATCH advertisement.
      params = ["grappa-test", "WATCHFOO=1", "MONITORBAR=2"]
      isupport = ISupport.merge_isupport(params, ISupport.default())
      assert ISupport.presence_mechanism(isupport) == :none
    end
  end
end
