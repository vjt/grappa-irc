defmodule Grappa.Cic.WireTest do
  @moduledoc """
  Tests for `Grappa.Cic.Wire` — single source of truth for the
  cic bundle-refresh push wire shape (`POST /admin/cic-bundle-changed`
  broadcast + Channel after-join snapshot push).
  """
  use ExUnit.Case, async: true

  alias Grappa.Cic.Wire

  describe "bundle_hash/2" do
    test "wraps hash + version in the canonical wire shape" do
      assert Wire.bundle_hash("abc123", "1.2.4") == %{
               kind: "bundle_hash",
               hash: "abc123",
               version: "1.2.4"
             }
    end

    test "kind is always the string literal 'bundle_hash'" do
      assert Wire.bundle_hash("zzz", "9.9.9").kind == "bundle_hash"
    end

    test "preserves the hash binary verbatim (no transformation)" do
      hash = "RvD22cM9-fancy_hash.with.dots"
      assert Wire.bundle_hash(hash, "0.0.1").hash == hash
    end

    test "omits the version key when the version is nil (#292 — unknown build)" do
      # nil version = bundle predates the meta tag / parse miss. The wire
      # carries hash-only; cic falls back to the build-hash display.
      assert Wire.bundle_hash("abc123", nil) == %{kind: "bundle_hash", hash: "abc123"}
    end

    test "omits the version key when the version is an empty string" do
      assert Wire.bundle_hash("abc123", "") == %{kind: "bundle_hash", hash: "abc123"}
    end
  end
end
