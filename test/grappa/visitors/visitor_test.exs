defmodule Grappa.Visitors.VisitorTest do
  @moduledoc """
  Schema-level tests for `Grappa.Visitors.Visitor`. The
  end-to-end happy-path lives in `Grappa.Visitors.LoginTest`; this
  file pins the changeset's per-field validators in isolation so a
  regression on one rule doesn't get hidden by an adjacent failure.
  """
  use ExUnit.Case, async: true

  alias Grappa.Visitors.Visitor

  defp valid_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        nick: "vjt",
        network_slug: "azzurra",
        expires_at: DateTime.add(DateTime.utc_now(), 7 * 24 * 3600, :second),
        ip: "127.0.0.1"
      },
      overrides
    )
  end

  describe "create_changeset/1" do
    test "valid for fully-populated attrs with future expires_at" do
      cs = Visitor.create_changeset(valid_attrs())
      assert cs.valid?
    end

    test "accepts optional ident + realname at creation (#152 login-Advanced)" do
      cs = Visitor.create_changeset(valid_attrs(%{ident: "~grp", realname: "Real Name"}))
      assert cs.valid?
      # tilde stripped at the create boundary too
      assert Ecto.Changeset.get_change(cs, :ident) == "grp"
      assert Ecto.Changeset.get_change(cs, :realname) == "Real Name"
    end

    test "rejects an invalid ident at creation" do
      cs = Visitor.create_changeset(valid_attrs(%{ident: "a b"}))
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "rejects past expires_at (B5.4 M-pers-3)" do
      # System-clock skew or a bad operator-supplied TTL must NOT slide
      # past the time-monotonicity contract — a visitor whose row is
      # born already-expired would be reaped on the next sweep, but in
      # the meantime would consume `(nick, network_slug)` uniqueness
      # and could shadow a legitimate concurrent registration.
      past = DateTime.add(DateTime.utc_now(), -3600, :second)
      cs = Visitor.create_changeset(valid_attrs(%{expires_at: past}))

      refute cs.valid?
      assert "must be in the future" in errors_on(cs).expires_at
    end

    test "rejects expires_at exactly equal to now" do
      # `compare/2` returns :eq for the equal case; treating :eq as a
      # rejection is the safer default — a row born expired is no row.
      now = DateTime.utc_now()
      cs = Visitor.create_changeset(valid_attrs(%{expires_at: now}))

      refute cs.valid?
      assert "must be in the future" in errors_on(cs).expires_at
    end

    test "expires_at validation does NOT fire when expires_at is missing" do
      # validate_required runs first; the future-validator only fires
      # when the field is present. Otherwise we'd surface two errors
      # for a single absent field — one "can't be blank", one
      # "must be in the future" against `nil`.
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
        nick: "vjt",
        network_slug: "azzurra",
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
        nick: "vjt",
        network_slug: "azzurra",
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

  describe "identity_changeset/2 (#152 live-apply)" do
    setup do
      {:ok, visitor: %Visitor{id: Ecto.UUID.generate(), nick: "vjt"}}
    end

    test "casts ident + realname", %{visitor: visitor} do
      cs = Visitor.identity_changeset(visitor, %{ident: "grp", realname: "Real Name"})
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp"
      assert Ecto.Changeset.get_change(cs, :realname) == "Real Name"
    end

    test "strips a leading tilde from ident (anti-spoof)", %{visitor: visitor} do
      cs = Visitor.identity_changeset(visitor, %{ident: "~grp"})
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp"
    end

    test "rejects an over-length ident", %{visitor: visitor} do
      cs = Visitor.identity_changeset(visitor, %{ident: String.duplicate("a", 11)})
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "rejects a realname carrying CR/LF/NUL (wire-injection guard)", %{visitor: visitor} do
      cs = Visitor.identity_changeset(visitor, %{realname: "evil\r\nQUIT"})
      refute cs.valid?
      assert "contains CR, LF, or NUL byte" in errors_on(cs).realname
    end

    test "accepts a free-form realname with spaces (no anti-spoof)", %{visitor: visitor} do
      cs = Visitor.identity_changeset(visitor, %{realname: "Marcello B. — grappa"})
      assert cs.valid?
    end

    test "empty attrs is a valid no-op changeset", %{visitor: visitor} do
      assert Visitor.identity_changeset(visitor, %{}).valid?
    end

    test "clearing a set field with \"\" resets it to nil (→ falls back to default)", %{
      visitor: _visitor
    } do
      # #152 clear-to-default contract: a visitor who blanks the ident/
      # realname field in Settings sends "". Ecto's cast maps "" to nil for
      # a :string field (default empty_values), so the change persists as
      # nil — and the SessionPlan effective_ident/effective_realname
      # fallbacks then apply (ident → nick, realname → "Grappa Visitor").
      # Without this, a "cleared" field would silently keep its old value.
      seeded = %Visitor{id: Ecto.UUID.generate(), nick: "vjt", ident: "grp", realname: "Old Name"}
      cs = Visitor.identity_changeset(seeded, %{ident: "", realname: ""})
      assert cs.valid?
      assert Ecto.Changeset.get_field(cs, :ident) == nil
      assert Ecto.Changeset.get_field(cs, :realname) == nil
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
