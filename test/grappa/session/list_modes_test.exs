defmodule Grappa.Session.ListModesTest do
  @moduledoc """
  #1251 — the type-A (list) channel-mode table.

  The two facts worth locking are the ones measured in the ircds' own
  sources, not guessed: `z` and `q` SHARE the 728/729 pair (bahamut's
  restrict list vs solanum's quiet list), and a type-A letter with no known
  pair must be dropped from the queryable set rather than offered.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.{ISupport, ListModes}

  describe "pairs/0" do
    test "each known letter maps to its measured {row, end} numeric pair" do
      assert ListModes.pairs() == %{
               "b" => {367, 368},
               "e" => {348, 349},
               "I" => {346, 347},
               "z" => {728, 729},
               "q" => {728, 729}
             }
    end

    test "z and q share 728/729 — the pair does NOT identify the list" do
      pairs = ListModes.pairs()
      assert pairs["z"] == pairs["q"]
    end
  end

  describe "known?/1" do
    test "true for every letter in the table" do
      for {mode, _} <- ListModes.pairs(), do: assert(ListModes.known?(mode))
    end

    test "false for a type-A letter we have no numeric pair for" do
      refute ListModes.known?("a")
    end

    test "case is significant — I is invex, i is the invite-only flag" do
      assert ListModes.known?("I")
      refute ListModes.known?("i")
    end
  end

  describe "queryable/1" do
    test "bahamut/Azzurra (CHANMODES=bz,k,l,…) offers exactly b and z" do
      isupport = ISupport.merge_isupport(["CHANMODES=bz,k,l,BcdijmMnOprRsStuU"], ISupport.default())

      assert ListModes.queryable(isupport) == ["b", "z"]
    end

    test "solanum (CHANMODES=eIbq,…) offers all four of its list modes" do
      isupport = ISupport.merge_isupport(["CHANMODES=eIbq,k,flj,CFLMPQScgimnprstuz"], ISupport.default())

      assert ListModes.queryable(isupport) == ["e", "I", "b", "q"]
    end

    test "a type-A letter with no known pair degrades quietly — advertised, not offered" do
      isupport = ISupport.merge_isupport(["CHANMODES=bX,k,l,imnpst"], ISupport.default())

      assert "X" in isupport.chanmodes.a
      refute "X" in ListModes.queryable(isupport)
      assert ListModes.queryable(isupport) == ["b"]
    end

    test "a network advertising NO type-A modes offers nothing" do
      isupport = ISupport.merge_isupport(["CHANMODES=,k,l,imnpst"], ISupport.default())

      assert ListModes.queryable(isupport) == []
    end

    test "the pre-005 default seed is queryable (b, e, I — bahamut's own seed)" do
      assert ListModes.queryable(ISupport.default()) == ["b", "e", "I"]
    end
  end
end
