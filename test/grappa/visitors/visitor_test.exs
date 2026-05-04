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

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
