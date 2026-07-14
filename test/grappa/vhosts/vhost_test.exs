defmodule Grappa.Vhosts.VhostTest do
  @moduledoc """
  #228 — `Grappa.Vhosts.Vhost` changeset. Mirrors
  `Grappa.Networks.Server`'s source-address validation (strict IP
  literal, canonicalized) but routes it through the shared
  `Grappa.Net.IpLiteral` helper instead of an inline copy. `address` is
  required; `in_pool` / `generally_available` default false.
  """
  use ExUnit.Case, async: true

  alias Grappa.Vhosts.Vhost

  describe "changeset/2 — address validation" do
    test "accepts a strict v6 literal and canonicalizes it" do
      cs = Vhost.changeset(%Vhost{}, %{address: "2001:0DB8:0000:0000:0000:0000:0000:0001"})
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :address) == "2001:db8::1"
    end

    test "accepts a strict v4 literal" do
      cs = Vhost.changeset(%Vhost{}, %{address: "192.0.2.1"})
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :address) == "192.0.2.1"
    end

    test "rejects a hostname" do
      cs = Vhost.changeset(%Vhost{}, %{address: "irc.example.org"})
      refute cs.valid?
      assert %{address: [_]} = errors_on(cs)
    end

    test "rejects a CIDR block" do
      refute Vhost.changeset(%Vhost{}, %{address: "2001:db8::/64"}).valid?
    end

    test "rejects an empty address" do
      refute Vhost.changeset(%Vhost{}, %{address: ""}).valid?
    end

    test "requires an address" do
      cs = Vhost.changeset(%Vhost{}, %{})
      refute cs.valid?
      assert %{address: [_]} = errors_on(cs)
    end
  end

  describe "changeset/2 — availability flags" do
    test "defaults in_pool and generally_available to false" do
      cs = Vhost.changeset(%Vhost{}, %{address: "192.0.2.1"})
      # Applied changeset carries schema defaults for the untouched flags.
      applied = Ecto.Changeset.apply_changes(cs)
      refute applied.in_pool
      refute applied.generally_available
    end

    test "accepts explicit true flags" do
      cs =
        Vhost.changeset(%Vhost{}, %{
          address: "192.0.2.1",
          in_pool: true,
          generally_available: true
        })

      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :in_pool) == true
      assert Ecto.Changeset.get_change(cs, :generally_available) == true
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _} -> msg end)
  end
end
