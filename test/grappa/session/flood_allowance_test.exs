defmodule Grappa.Session.FloodAllowanceTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.FloodAllowance

  describe "no_throttle_umode/1 — the per-flavour exempt letter" do
    test "is F on bahamut/Azzurra, the only flavour where the letter was read at source" do
      assert FloodAllowance.no_throttle_umode(:azzurra) == "F"
    end

    test "is absent on every flavour whose letter table we have NOT read" do
      # solanum core assigns no F (`user_modes[256]` is D/Q/S/Z/a/i/o/s/w/z),
      # and nothing was verified for hybrid. An unclassified network gets no
      # letter either: honouring one would be assuming an ircd, and the cost
      # of assuming wrong is a throttle switched OFF for a connection the
      # upstream still meters.
      assert FloodAllowance.no_throttle_umode(:atheme) == nil
      assert FloodAllowance.no_throttle_umode(:oftc) == nil
      assert FloodAllowance.no_throttle_umode(:unknown) == nil
      assert FloodAllowance.no_throttle_umode(nil) == nil
      assert FloodAllowance.no_throttle_umode(:some_future_ircd) == nil
    end
  end

  describe "classify/1 — the upstream allowance this session mirrors" do
    test "no facts at all reads as ordinary" do
      # The #216 hot-reload contract: a live proc whose state predates the
      # fields must answer the SAFE direction, not KeyError-crash.
      assert FloodAllowance.classify(%{}) == :ordinary
    end

    test "a session with no oper umode is ordinary" do
      assert FloodAllowance.classify(%{umodes: ["i", "w"], services_flavor: :azzurra}) ==
               :ordinary
    end

    test "an oper'd session gets the oper allowance" do
      assert FloodAllowance.classify(%{umodes: ["i", "o"], services_flavor: :azzurra}) == :oper
    end

    test "an oper carrying the flavour's no-throttle letter is exempt" do
      assert FloodAllowance.classify(%{umodes: ["F", "o"], services_flavor: :azzurra}) == :exempt
    end

    test "the exempt letter alone, without oper, is NOT exempt" do
      # bahamut's `F` is an oper flag (OFLAG_UMODEF), so requiring `+o`
      # alongside costs nothing there. Off bahamut it is the guard that
      # keeps an unrelated `F` from switching the throttle off for a plain
      # user we have no reason to trust.
      assert FloodAllowance.classify(%{umodes: ["F"], services_flavor: :azzurra}) == :ordinary
    end

    test "the exempt letter is per-flavour: F on a flavour without one is just an oper" do
      assert FloodAllowance.classify(%{umodes: ["F", "o"], services_flavor: :atheme}) == :oper
      assert FloodAllowance.classify(%{umodes: ["F", "o"], services_flavor: nil}) == :oper
    end

    test "the oper letter is o everywhere — it is the one RFC 1459 fixes" do
      for flavor <- [:azzurra, :atheme, :oftc, :unknown, nil] do
        assert FloodAllowance.classify(%{umodes: ["o"], services_flavor: flavor}) == :oper
      end
    end

    test "an uppercase O is not the oper umode" do
      # Some ircds spell a local/global distinction with `O`; the letter this
      # reads is the RFC one, and inventing a union would be the same mistake
      # #388 refused for the registered letter.
      assert FloodAllowance.classify(%{umodes: ["O"], services_flavor: :azzurra}) == :ordinary
    end
  end
end
