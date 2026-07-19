defmodule Grappa.VhostsTest do
  @moduledoc """
  #228 — `Grappa.Vhosts` context: inventory CRUD, per-subject grants,
  selection (authz-clamped), and the `effective_source/2` resolution
  precedence that feeds the session plan.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Vhosts

  # Unique v6 literal — mask the counter into a single valid hextet
  # (0..0xffff) so the strict-literal changeset always accepts it.
  defp addr do
    n = Bitwise.band(System.unique_integer([:positive]), 0xFFFF)
    "2001:db8::" <> String.downcase(Integer.to_string(n, 16))
  end

  describe "create_vhost/1" do
    test "creates a curated vhost with defaults" do
      {:ok, v} = Vhosts.create_vhost(%{address: "192.0.2.10"})
      assert v.address == "192.0.2.10"
      refute v.in_pool
      refute v.generally_available
    end

    test "canonicalizes the address" do
      {:ok, v} = Vhosts.create_vhost(%{address: "2001:0DB8:0000::0001"})
      assert v.address == "2001:db8::1"
    end

    test "rejects a duplicate address with :already_exists" do
      a = addr()
      {:ok, _} = Vhosts.create_vhost(%{address: a})
      assert {:error, :already_exists} = Vhosts.create_vhost(%{address: a})
    end

    test "rejects a non-literal with a changeset" do
      assert {:error, %Ecto.Changeset{}} = Vhosts.create_vhost(%{address: "not-an-ip"})
    end
  end

  describe "list_vhosts/0 + update_vhost/2 + delete_vhost/1" do
    test "lists all vhosts ordered by address" do
      {:ok, _} = Vhosts.create_vhost(%{address: "192.0.2.2"})
      {:ok, _} = Vhosts.create_vhost(%{address: "192.0.2.1"})
      addrs = Enum.map(Vhosts.list_vhosts(), & &1.address)
      assert "192.0.2.1" in addrs
      assert "192.0.2.2" in addrs
    end

    test "updates availability flags" do
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, v2} = Vhosts.update_vhost(v, %{in_pool: true, generally_available: true})
      assert v2.in_pool
      assert v2.generally_available
    end

    test "deletes a vhost" do
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      assert :ok = Vhosts.delete_vhost(v)
      refute Enum.any?(Vhosts.list_vhosts(), &(&1.id == v.id))
    end
  end

  describe "grant_vhost/2 + revoke_grant/1" do
    test "grants a vhost to a user subject" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id})
      assert grant.vhost_id == v.id
      assert grant.user_id == user.id
    end

    test "grants a vhost to a visitor subject" do
      visitor = visitor_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:visitor, visitor.id})
      assert grant.visitor_id == visitor.id
    end

    test "re-granting the same (vhost, subject) is idempotent-ish (:already_exists)" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id})
      assert {:error, :already_exists} = Vhosts.grant_vhost(v, {:user, user.id})
    end

    test "revoke removes the grant" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id})
      assert :ok = Vhosts.revoke_grant(grant)
      assert Vhosts.list_grants_for_subject({:user, user.id}) == []
    end
  end

  describe "allowed_vhosts/1 — union of generally-available + in_pool + granted" do
    test "includes generally-available vhosts" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}), & &1.id)
      assert ga.id in allowed
    end

    test "includes vhosts granted to the subject but not generally available" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}), & &1.id)
      assert granted.id in allowed
    end

    test "excludes a private vhost the subject was never granted" do
      user = user_fixture()
      other = user_fixture()
      {:ok, priv} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(priv, {:user, other.id})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}), & &1.id)
      refute priv.id in allowed
    end

    # #251 — the pool is seeded `in_pool=1, generally_available=0`, so before
    # this fix a no-grant subject had an EMPTY allow-set ("can't set my vhost").
    # in_pool now joins the allow-set: admin decides AVAILABILITY (pool
    # membership), the user decides SELECTION.
    test "includes in_pool vhosts so a no-grant subject can self-select the pool" do
      user = user_fixture()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true, generally_available: false})

      allowed = Enum.map(Vhosts.allowed_vhosts({:user, user.id}), & &1.id)
      assert pool.id in allowed
    end
  end

  describe "set_selection/2 — authz-clamped to allowed set" do
    test "persists an allowed selection" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})

      assert {:ok, [addr]} = Vhosts.set_selection({:user, user.id}, [ga.address])
      assert addr == ga.address
      assert Vhosts.get_selection({:user, user.id}) == [ga.address]
    end

    test "rejects a selection outside the allowed set" do
      user = user_fixture()
      {:ok, forbidden} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      assert {:error, :forbidden_vhost} =
               Vhosts.set_selection({:user, user.id}, [forbidden.address])
    end

    test "get_selection re-clamps a stale selection whose grant was revoked" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address])

      :ok = Vhosts.revoke_grant(grant)
      # Selection persisted, but the address is no longer allowed → clamped out.
      assert Vhosts.get_selection({:user, user.id}) == []
    end
  end

  # #266 — the precedence is INVERTED from #251: an admin-set per-network
  # `server_source` now WINS over the subject's vhost self-selection (and the
  # pool). Libera go-live posture: an admin-pinned, accountable egress is the
  # honest answer; a user-driven rotating vhost reads as ban-evasion. When no
  # admin source is set the vhost selection/pool fallback is unchanged.
  describe "effective_source/2 — resolution precedence (#266: admin source wins)" do
    test "1. an admin server_source WINS over an active vhost selection" do
      user = user_fixture()
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address])

      # Subject HAS a selection, but the network pins a source → the pin binds.
      assert Vhosts.effective_source({:user, user.id}, "192.0.2.99") == "192.0.2.99"
    end

    test "2. falls back to the vhost selection when there is no admin source" do
      user = user_fixture()
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address])

      assert Vhosts.effective_source({:user, user.id}, nil) == sel.address
    end

    test "2b. multi-selection (no admin source) returns one of the selected (random per connection)" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, b} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [a.address, b.address])

      picked = Vhosts.effective_source({:user, user.id}, nil)
      assert picked in [a.address, b.address]
    end

    test "3. an admin server_source binds when there is no selection" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, "192.0.2.50") == "192.0.2.50"
    end

    test "3b. nil (pool/kernel default) when neither an admin source nor a selection" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, nil) == nil
    end

    test "a revoked-grant selection does NOT bind — nil admin source falls through to nil" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address])
      :ok = Vhosts.revoke_grant(grant)

      # The clamped-out selection is gone AND there is no admin source → nil.
      assert Vhosts.effective_source({:user, user.id}, nil) == nil
    end
  end

  describe "pool_addresses/0 — DB-driven rotation set" do
    test "returns only in_pool vhost addresses" do
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, out} = Vhosts.create_vhost(%{address: addr(), in_pool: false})

      pool = Vhosts.pool_addresses()
      refute out.address in pool
      assert Enum.all?(pool, &is_binary/1)
    end
  end

  describe "effective_pool/1 — in_pool minus fixed sources (spec §3)" do
    test "subtracts a per-server fixed source that overlaps the pool" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      {:ok, b} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      effective = Vhosts.effective_pool([a.address])
      refute a.address in effective
      assert b.address in effective
    end

    test "a fixed source not in the pool leaves it unchanged" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      effective = Vhosts.effective_pool(["2001:db8:ffff::1"])
      assert a.address in effective
    end

    test "an empty fixed-source list is the full in_pool set" do
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), in_pool: true})
      assert a.address in Vhosts.effective_pool([])
    end
  end
end
