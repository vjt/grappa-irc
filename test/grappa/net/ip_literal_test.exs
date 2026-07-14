defmodule Grappa.Net.IpLiteralTest do
  @moduledoc """
  #228 — shared strict IP-literal canonicalization. Extracted from the
  `Grappa.Networks.Server` changeset so the new `Grappa.Vhosts.Vhost`
  changeset validates source addresses through the SAME rule (CLAUDE.md
  "implement once, reuse everywhere") instead of copy-pasting the
  strict-parse + `:inet.ntoa/1` canonicalization.
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.IpLiteral

  describe "canonicalize/1" do
    test "accepts a strict IPv4 literal and returns it canonical" do
      assert {:ok, "192.0.2.1"} = IpLiteral.canonicalize("192.0.2.1")
    end

    test "accepts a strict IPv6 literal and rewrites it to canonical compressed form" do
      # Uppercase + non-compressed → lowercase compressed via :inet.ntoa/1.
      assert {:ok, "2001:db8::1"} = IpLiteral.canonicalize("2001:0DB8:0000:0000:0000:0000:0000:0001")
    end

    test "rejects a hostname" do
      assert :error = IpLiteral.canonicalize("irc.example.org")
    end

    test "rejects a CIDR block" do
      assert :error = IpLiteral.canonicalize("2001:db8::/64")
    end

    test "rejects an empty string" do
      assert :error = IpLiteral.canonicalize("")
    end

    test "rejects a zero-padded octet (non-strict)" do
      assert :error = IpLiteral.canonicalize("192.000.002.001")
    end
  end

  describe "family/1" do
    test "returns :inet for a v4 literal" do
      assert :inet = IpLiteral.family("192.0.2.1")
    end

    test "returns :inet6 for a v6 literal" do
      assert :inet6 = IpLiteral.family("2001:db8::1")
    end
  end
end
