defmodule Grappa.Wire.TimeTest do
  @moduledoc """
  Tests for `Grappa.Wire.Time` — cross-context shared helper for the
  `DateTime.t() | nil → ISO-8601 String.t() | nil` projection that
  every `*.Wire` module uses on its timestamp fields.

  Bucket G U1 (codebase-review-2026-05-12) extracted this from
  `Grappa.Networks.Wire`'s private `iso8601_or_nil/1`. The helper sits
  OUTSIDE the per-context Wire boundary because timestamp formatting
  is the same across contexts and the wire-shape requirement
  (`api.ts` declares `inserted_at: string`) is identical everywhere.
  """
  use ExUnit.Case, async: true

  alias Grappa.Wire.Time

  describe "iso8601_or_nil/1" do
    test "preserves nil verbatim" do
      assert Time.iso8601_or_nil(nil) == nil
    end

    test "encodes a DateTime to its ISO-8601 string" do
      {:ok, dt, 0} = DateTime.from_iso8601("2026-05-12T18:30:45.123456Z")
      assert Time.iso8601_or_nil(dt) == "2026-05-12T18:30:45.123456Z"
    end

    test "round-trips usec precision" do
      {:ok, dt, 0} = DateTime.from_iso8601("2026-01-01T00:00:00.000001Z")
      assert Time.iso8601_or_nil(dt) == DateTime.to_iso8601(dt)
    end

    test "round-trips second precision" do
      {:ok, dt, 0} = DateTime.from_iso8601("2026-01-01T00:00:00Z")
      assert Time.iso8601_or_nil(dt) == DateTime.to_iso8601(dt)
    end
  end
end
