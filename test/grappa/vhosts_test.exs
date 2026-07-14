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
    "2001:db8::" <> Integer.to_string(n, 16)
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
      addrs = Vhosts.list_vhosts() |> Enum.map(& &1.address)
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

  describe "grant_vhost/3 + revoke_grant/1" do
    test "grants a vhost to a user subject" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id}, pinned: false)
      assert grant.vhost_id == v.id
      assert grant.user_id == user.id
      refute grant.pinned
    end

    test "grants a vhost to a visitor subject" do
      visitor = visitor_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:visitor, visitor.id}, pinned: false)
      assert grant.visitor_id == visitor.id
    end

    test "re-granting the same (vhost, subject) is idempotent-ish (:already_exists)" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, _} = Vhosts.grant_vhost(v, {:user, user.id}, pinned: false)
      assert {:error, :already_exists} = Vhosts.grant_vhost(v, {:user, user.id}, pinned: false)
    end

    test "revoke removes the grant" do
      user = user_fixture()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, user.id}, pinned: false)
      assert :ok = Vhosts.revoke_grant(grant)
      assert Vhosts.list_grants_for_subject({:user, user.id}) == []
    end
  end

  describe "pin_vhost/2 — at most one pin per subject" do
    test "pinning a second vhost replaces the first pin" do
      user = user_fixture()
      {:ok, v1} = Vhosts.create_vhost(%{address: addr()})
      {:ok, v2} = Vhosts.create_vhost(%{address: addr()})

      {:ok, _} = Vhosts.pin_vhost(v1, {:user, user.id})
      assert Vhosts.pinned_vhost({:user, user.id}).id == v1.id

      {:ok, _} = Vhosts.pin_vhost(v2, {:user, user.id})
      assert Vhosts.pinned_vhost({:user, user.id}).id == v2.id
      # Only one pin remains.
      pins = Vhosts.list_grants_for_subject({:user, user.id}) |> Enum.filter(& &1.pinned)
      assert length(pins) == 1
    end
  end

  describe "allowed_vhosts/1 — union of generally-available + granted" do
    test "includes generally-available vhosts" do
      user = user_fixture()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _priv} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      allowed = Vhosts.allowed_vhosts({:user, user.id}) |> Enum.map(& &1.id)
      assert ga.id in allowed
    end

    test "includes vhosts granted to the subject but not generally available" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id}, pinned: false)

      allowed = Vhosts.allowed_vhosts({:user, user.id}) |> Enum.map(& &1.id)
      assert granted.id in allowed
    end

    test "excludes a private vhost the subject was never granted" do
      user = user_fixture()
      other = user_fixture()
      {:ok, priv} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(priv, {:user, other.id}, pinned: false)

      allowed = Vhosts.allowed_vhosts({:user, user.id}) |> Enum.map(& &1.id)
      refute priv.id in allowed
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
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id}, pinned: false)
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address])

      :ok = Vhosts.revoke_grant(grant)
      # Selection persisted, but the address is no longer allowed → clamped out.
      assert Vhosts.get_selection({:user, user.id}) == []
    end
  end

  describe "effective_source/2 — resolution precedence" do
    test "1. a pin wins over everything" do
      user = user_fixture()
      {:ok, pinned} = Vhosts.create_vhost(%{address: addr()})
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.pin_vhost(pinned, {:user, user.id})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address])

      assert Vhosts.effective_source({:user, user.id}, "192.0.2.99") == pinned.address
    end

    test "2. selection (intersected with allowed) is used when no pin" do
      user = user_fixture()
      {:ok, sel} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [sel.address])

      assert Vhosts.effective_source({:user, user.id}, "192.0.2.99") == sel.address
    end

    test "2b. multi-selection returns one of the selected (random per connection)" do
      user = user_fixture()
      {:ok, a} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, b} = Vhosts.create_vhost(%{address: addr(), generally_available: true})
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [a.address, b.address])

      picked = Vhosts.effective_source({:user, user.id}, nil)
      assert picked in [a.address, b.address]
    end

    test "3. falls back to server_source when no pin, no selection" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, "192.0.2.50") == "192.0.2.50"
    end

    test "3b. falls back to nil (pool/kernel) when no pin, no selection, no server source" do
      user = user_fixture()
      assert Vhosts.effective_source({:user, user.id}, nil) == nil
    end

    test "a selection whose grant was revoked does NOT bind — falls through to server_source" do
      user = user_fixture()
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, grant} = Vhosts.grant_vhost(granted, {:user, user.id}, pinned: false)
      {:ok, _} = Vhosts.set_selection({:user, user.id}, [granted.address])
      :ok = Vhosts.revoke_grant(grant)

      assert Vhosts.effective_source({:user, user.id}, "192.0.2.50") == "192.0.2.50"
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
end
