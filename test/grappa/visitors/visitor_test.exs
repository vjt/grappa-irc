defmodule Grappa.Visitors.VisitorTest do
  @moduledoc """
  Schema-level tests for `Grappa.Visitors.Visitor` — the pure identity/TTL
  row (#211 phase 7). Per-network identity (nick/ident/realname/password)
  moved to `Grappa.Networks.Credential`, so this file pins ONLY the row's
  own changesets: create (expires_at + ip), the TTL guards
  (touch/expire/mark_permanent), and ip.
  """
  use ExUnit.Case, async: true

  alias Grappa.Visitors.Visitor

  defp valid_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        expires_at: DateTime.add(DateTime.utc_now(), 7 * 24 * 3600, :second),
        ip: "127.0.0.1"
      },
      overrides
    )
  end

  describe "create_changeset/1" do
    test "valid for a future expires_at + ip" do
      cs = Visitor.create_changeset(valid_attrs())
      assert cs.valid?
    end

    test "valid with ip omitted (mix-task / no-remote_ip path)" do
      cs = Visitor.create_changeset(%{expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)})
      assert cs.valid?
    end

    test "rejects past expires_at (B5.4 M-pers-3)" do
      # A row born already-expired would be reaped on the next sweep; reject
      # it at the boundary rather than admit a zombie identity.
      past = DateTime.add(DateTime.utc_now(), -3600, :second)
      cs = Visitor.create_changeset(valid_attrs(%{expires_at: past}))

      refute cs.valid?
      assert "must be in the future" in errors_on(cs).expires_at
    end

    test "rejects expires_at exactly equal to now" do
      now = DateTime.utc_now()
      cs = Visitor.create_changeset(valid_attrs(%{expires_at: now}))

      refute cs.valid?
      assert "must be in the future" in errors_on(cs).expires_at
    end

    test "expires_at validation does NOT fire when expires_at is missing" do
      attrs = Map.delete(valid_attrs(), :expires_at)
      cs = Visitor.create_changeset(attrs)

      refute cs.valid?
      assert "can't be blank" in errors_on(cs).expires_at
      refute "must be in the future" in (errors_on(cs)[:expires_at] || [])
    end
  end

  describe "touch_changeset/2 monotonic expires_at (H13, REV-D)" do
    setup do
      visitor = %Visitor{
        id: Ecto.UUID.generate(),
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      %{visitor: visitor}
    end

    test "accepts a forward bump (new > prev)", %{visitor: visitor} do
      forward = DateTime.add(visitor.expires_at, 60, :second)
      cs = Visitor.touch_changeset(visitor, forward)
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :expires_at) == forward
    end

    test "accepts the same instant (no-op write — same-tick under load is benign)",
         %{visitor: visitor} do
      cs = Visitor.touch_changeset(visitor, visitor.expires_at)
      assert cs.valid?
    end

    test "rejects a backward jump (system-clock skew)", %{visitor: visitor} do
      backward = DateTime.add(visitor.expires_at, -60, :second)
      cs = Visitor.touch_changeset(visitor, backward)

      refute cs.valid?
      assert "must not move backward (system-clock skew?)" in errors_on(cs).expires_at
    end
  end

  describe "expire_changeset/2 bypasses monotonicity guard" do
    test "allows backward time (mark_failed forced-expiry semantic)" do
      visitor = %Visitor{
        id: Ecto.UUID.generate(),
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      now = DateTime.utc_now()
      cs = Visitor.expire_changeset(visitor, now)
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :expires_at) == now
    end
  end

  describe "ip_changeset/2" do
    setup do
      {:ok, visitor: %Visitor{id: Ecto.UUID.generate(), ip: "10.0.0.1"}}
    end

    test "accepts a fresh String IP", %{visitor: visitor} do
      cs = Visitor.ip_changeset(visitor, "203.0.113.42")
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ip) == "203.0.113.42"
    end

    test "accepts nil (no remote_ip on the conn — mix-task path)", %{visitor: visitor} do
      cs = Visitor.ip_changeset(visitor, nil)
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ip) == nil
    end

    test "rejects non-string non-nil via the guard", %{visitor: visitor} do
      assert_raise FunctionClauseError, fn ->
        Visitor.ip_changeset(visitor, {1, 2, 3, 4})
      end
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
