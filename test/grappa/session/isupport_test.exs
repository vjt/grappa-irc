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
  - `user_prefix/2` — mode letter → sigil for per-user (membership)
    modes, or `:error` for channel-level modes.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.ISupport

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

    test "preserves the current table when tokens are absent" do
      params = ["grappa-test", "NETWORK=Azzurra", "are supported by this server"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
    end

    test "ignores a malformed CHANMODES token (wrong class count)" do
      # A CHANMODES with fewer than 4 comma-classes is malformed; keep
      # the prior table rather than corrupting param-arity classification.
      params = ["grappa-test", "CHANMODES=beI,k"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
    end

    test "ignores a malformed PREFIX token (unbalanced modes/sigils)" do
      params = ["grappa-test", "PREFIX=(ohv)@%"]
      d = ISupport.default()

      assert ISupport.merge_isupport(params, d) == d
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
end
