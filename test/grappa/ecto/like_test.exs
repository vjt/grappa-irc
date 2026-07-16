defmodule Grappa.Ecto.LikeTest do
  @moduledoc """
  #257 — `Grappa.Ecto.Like` is the single source of truth for building a
  safe SQL `LIKE` substring pattern from arbitrary user input. The LIKE
  metacharacters `%` (any run) and `_` (any single char) — plus the `\\`
  escape char itself — MUST be escaped, or an operator typing a nick with
  an underscore (legal in `Identifier.valid_nick?/1`) would silently
  wildcard-match unrelated rows in the subject-search autocomplete.
  """
  use ExUnit.Case, async: true

  alias Grappa.Ecto.Like

  describe "escape/1" do
    test "escapes the LIKE wildcard metacharacters and the escape char" do
      # `\\` first so the subsequent escapes aren't themselves re-escaped.
      assert Like.escape("a_b%c\\d") == "a\\_b\\%c\\\\d"
    end

    test "leaves a plain string untouched" do
      assert Like.escape("plainnick") == "plainnick"
    end

    test "escapes an empty string to an empty string" do
      assert Like.escape("") == ""
    end
  end

  describe "contains/1" do
    test "wraps the escaped input in %...% for a substring match" do
      assert Like.contains("vjt") == "%vjt%"
    end

    test "escapes metacharacters inside the substring pattern" do
      # The `_` is escaped so it matches a literal underscore, not any char.
      assert Like.contains("foo_bar") == "%foo\\_bar%"
    end
  end
end
