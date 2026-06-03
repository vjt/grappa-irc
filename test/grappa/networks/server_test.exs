defmodule Grappa.Networks.ServerTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Server

  @base %{network_id: 1, host: "irc.example.org", port: 6697}

  defp source_changeset(value),
    do: Server.changeset(%Server{}, Map.put(@base, :source_address, value))

  describe "source_address validation" do
    test "accepts a strict IPv4 literal and stores it canonical" do
      cs = source_changeset("127.0.0.1")
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :source_address) == "127.0.0.1"
    end

    test "accepts a strict IPv6 literal and stores it canonical (compressed)" do
      cs = source_changeset("2a03:4000:0002:033c:0000:0000:0000:9000")
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :source_address) == "2a03:4000:2:33c::9000"
    end

    test "NULL source is valid (pool semantics, unchanged)" do
      assert Server.changeset(%Server{}, @base).valid?
    end

    test "rejects a hostname" do
      refute source_changeset("irc.azzurra.org").valid?
    end

    test "rejects CIDR notation" do
      refute source_changeset("2a03:4000:2:33c::/64").valid?
    end

    test "rejects the empty string" do
      refute source_changeset("").valid?
    end

    test "rejects garbage" do
      refute source_changeset("not-an-ip").valid?
    end

    test "rejects a non-strict (zero-padded-octet) IPv4" do
      # :inet.parse_ipv4strict_address rejects 0177-style / leading-zero octets
      refute source_changeset("010.0.0.1").valid?
    end
  end
end
