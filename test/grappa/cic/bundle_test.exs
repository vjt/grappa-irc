defmodule Grappa.Cic.BundleTest do
  use ExUnit.Case, async: true

  alias Grappa.Cic.Bundle

  describe "parse_hash/1" do
    test "extracts vite hash from real index.html shape" do
      html = """
      <!doctype html>
      <html>
        <head>
          <script type="module" crossorigin src="/assets/index-RvD22cM9.js"></script>
          <link rel="stylesheet" crossorigin href="/assets/index-DZ6NA7Rm.css">
        </head>
      </html>
      """

      assert Bundle.parse_hash(html) == "RvD22cM9"
    end

    test "returns nil when the script tag is missing" do
      assert Bundle.parse_hash("<html><head></head></html>") == nil
    end

    test "returns nil for empty input" do
      assert Bundle.parse_hash("") == nil
    end

    test "ignores asset tags that aren't the index entry" do
      html = ~s(<script src="/assets/vendor-abc.js"></script>)
      assert Bundle.parse_hash(html) == nil
    end

    test "matches across attribute order variations" do
      html = ~s(<script crossorigin type="module" src="/assets/index-XYZ123.js"></script>)
      assert Bundle.parse_hash(html) == "XYZ123"
    end
  end

  describe "current_hash/0" do
    # current_hash/0 reads the live bundle on disk. In test env the
    # file may or may not exist; both shapes are valid (cic build is
    # not a test-suite prerequisite). Assert the type contract only.
    test "returns a binary or nil" do
      assert Bundle.current_hash() == nil or is_binary(Bundle.current_hash())
    end
  end

  describe "parse_version/1 (#292)" do
    test "extracts the semver from the vite-injected <meta> tag" do
      html = """
      <!doctype html>
      <html>
        <head>
          <meta name="cicchetto-version" content="1.2.4">
          <script type="module" crossorigin src="/assets/index-RvD22cM9.js"></script>
        </head>
      </html>
      """

      assert Bundle.parse_version(html) == "1.2.4"
    end

    test "returns nil when the version meta tag is absent" do
      html = ~s(<html><head><meta name="theme-color" content="#0a0a0a"></head></html>)
      assert Bundle.parse_version(html) == nil
    end

    test "returns nil for empty input" do
      assert Bundle.parse_version("") == nil
    end

    test "does not match a different meta tag's content" do
      html = ~s(<meta name="theme-color" content="#0a0a0a">)
      assert Bundle.parse_version(html) == nil
    end
  end

  describe "current_version/0 (#292)" do
    # Live-read of the deployed dist, same contract as current_hash/0:
    # the file may or may not exist in test env. Assert the type only.
    test "returns a binary or nil" do
      assert Bundle.current_version() == nil or is_binary(Bundle.current_version())
    end
  end
end
