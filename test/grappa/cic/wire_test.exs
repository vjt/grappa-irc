defmodule Grappa.Cic.WireTest do
  @moduledoc """
  Tests for `Grappa.Cic.Wire` — single source of truth for the
  cic bundle-refresh push wire shape (`POST /admin/cic-bundle-changed`
  broadcast + Channel after-join snapshot push).
  """
  use ExUnit.Case, async: true

  alias Grappa.Cic.Wire

  describe "bundle_hash/1" do
    test "wraps a hash binary in the canonical %{kind, hash} wire shape" do
      assert Wire.bundle_hash("abc123") == %{kind: "bundle_hash", hash: "abc123"}
    end

    test "kind is always the string literal 'bundle_hash'" do
      assert Wire.bundle_hash("zzz").kind == "bundle_hash"
    end

    test "preserves the hash binary verbatim (no transformation)" do
      hash = "RvD22cM9-fancy_hash.with.dots"
      assert Wire.bundle_hash(hash).hash == hash
    end
  end
end
