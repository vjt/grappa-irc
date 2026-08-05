defmodule Grappa.Session.PerformListTest do
  @moduledoc """
  #189 / #885 — pure expansion of the on-connect perform list. `expand/2`
  turns the stored free text into the executable wire lines: skips blank +
  `#`-comment lines, substitutes `$nickserv_pass` / `$oper_pass` / `$nick`,
  and reports the STRUCTURAL suppression signal `consumed_nickserv_pass?`
  (did an EXECUTED line actually substitute the NickServ password) so the
  caller can skip the built-in identify without ever text-scanning for
  identify verbs.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.PerformList

  @bindings %{nickserv_pass: "nspw", oper_pass: "oppw", nick: "vjt"}

  describe "expand/2" do
    test "nil / blank text yields no lines and consumes nothing" do
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand(nil, @bindings)
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand("", @bindings)
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand("   \n\n", @bindings)
    end

    test "substitutes both secret variables and reports the raw (unexpanded) form for logging" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass", @bindings)

      assert consumed?

      assert lines == ["NS IDENTIFY nspw", "OPER vjt oppw"]
    end

    test "substitutes $nick so an identify can name the account" do
      %{lines: lines} =
        PerformList.expand("NS IDENTIFY $nick $nickserv_pass\nMODE $nick +x", @bindings)

      assert lines == ["NS IDENTIFY vjt nspw", "MODE vjt +x"]
    end

    test "$nick does NOT eat the $nickserv_pass prefix" do
      # `nick` is a PREFIX of `nickserv_pass`, so a careless alternation
      # expands `$nickserv_pass` to the nick plus a literal `serv_pass` tail
      # and the password silently never reaches the wire. The guard is the
      # `nick\b` boundary, not the branch order — measured: with the boundary
      # in place, putting `nick` first changes nothing here.
      %{lines: [line], consumed_nickserv_pass?: consumed?} =
        PerformList.expand("NS IDENTIFY $nickserv_pass", @bindings)

      assert line == "NS IDENTIFY nspw"
      refute line =~ "serv_pass"
      assert consumed?
    end

    test "a longer word starting with the $nick token is left verbatim" do
      # `$nick` is a whole token, not a prefix that eats into its neighbour:
      # a user writing `$nickname` gets their text back, not `vjtname`.
      %{lines: lines} = PerformList.expand("PRIVMSG #chan :$nickname\nWHOIS $nicks", @bindings)

      assert lines == ["PRIVMSG #chan :$nickname", "WHOIS $nicks"]
    end

    test "unknown $… tokens still pass through verbatim" do
      %{lines: lines} = PerformList.expand("PRIVMSG #chan :$realname $host", @bindings)

      assert lines == ["PRIVMSG #chan :$realname $host"]
    end

    test "$nick is not a secret: using it alone does not consume the NickServ password" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("MODE $nick +x", @bindings)

      refute consumed?
      assert lines == ["MODE vjt +x"]
    end

    test "skips blank lines and #-comment lines" do
      %{lines: lines} =
        PerformList.expand("# on-connect\n\nMODE vjt +x\n   # indented comment\n", @bindings)

      assert lines == ["MODE vjt +x"]
    end

    test "a $nickserv_pass inside a COMMENTED line does NOT count as consumed" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("# NS IDENTIFY $nickserv_pass\nMODE vjt +x", @bindings)

      refute consumed?
      assert lines == ["MODE vjt +x"]
    end

    test "no $nickserv_pass reference means not consumed, even if oper_pass is used" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("OPER vjt $oper_pass", @bindings)

      refute consumed?
      assert lines == ["OPER vjt oppw"]
    end

    test "trims trailing whitespace / CR and handles CRLF line endings" do
      %{lines: lines} = PerformList.expand("MODE vjt +x  \r\nWHOIS me\r\n", @bindings)

      assert lines == ["MODE vjt +x", "WHOIS me"]
    end

    test "a substituted secret is not re-scanned for variables (single-pass)" do
      %{lines: lines} =
        PerformList.expand("OPER vjt $oper_pass", %{
          nickserv_pass: "x",
          oper_pass: "a$nickserv_pass",
          nick: "vjt"
        })

      # The literal '$nickserv_pass' inside the oper password value stays verbatim.
      assert lines == ["OPER vjt a$nickserv_pass"]
    end

    test "a missing nickserv_pass value never leaks the literal token and is not consumed" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("NS IDENTIFY $nickserv_pass", %{
          nickserv_pass: nil,
          oper_pass: nil,
          nick: "vjt"
        })

      refute consumed?
      assert lines == ["NS IDENTIFY "]
    end

    test "an unbound $nick expands to empty, never the literal token" do
      %{lines: lines} =
        PerformList.expand("MODE $nick +x", %{nickserv_pass: nil, oper_pass: nil, nick: nil})

      assert lines == ["MODE  +x"]
    end
  end
end
