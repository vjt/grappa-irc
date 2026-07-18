defmodule Grappa.Themes.TokenModelTest do
  use ExUnit.Case, async: true

  alias Grappa.Themes.{BuiltinBackgrounds, TokenModel}

  defp valid_colors do
    Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end)
  end

  defp valid_raw do
    %{
      "colors" => valid_colors(),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  test "color_keys is the frozen 27-token set" do
    keys = TokenModel.color_keys()
    assert length(keys) == 27
    assert "bg" in keys
    assert "mode_plain" in keys
    assert "nick_0" in keys
    assert "nick_15" in keys
  end

  test "sanitize accepts a full valid token map and drops unknown keys" do
    raw =
      valid_raw()
      |> put_in(["colors", "evil"], "url(http://x)")
      |> Map.put("top_level_junk", "<script>")
      |> update_in(["background"], &Map.put(&1, "junk", 1))

    assert {:ok, clean} = TokenModel.sanitize(raw)
    assert Enum.sort(Map.keys(clean)) == ["background", "colors", "font_family"]
    assert Enum.sort(Map.keys(clean["colors"])) == Enum.sort(TokenModel.color_keys())
    refute Map.has_key?(clean["colors"], "evil")

    assert clean["background"] ==
             %{"image_id" => nil, "builtin" => nil, "size" => "cover", "opacity" => 0.3}
  end

  test "sanitize keeps a valid uploads-slug image_id" do
    slug = String.duplicate("a", 26)
    raw = put_in(valid_raw(), ["background", "image_id"], slug)
    assert {:ok, clean} = TokenModel.sanitize(raw)
    assert clean["background"]["image_id"] == slug
  end

  test "sanitize rejects a malformed image_id" do
    raw = put_in(valid_raw(), ["background", "image_id"], "../etc/passwd")
    assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
  end

  test "sanitize rejects a non-hex color (CSS injection attempt)" do
    raw = put_in(valid_raw(), ["colors", "bg"], "red; }body{background:url(http://evil)}")
    assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
  end

  test "sanitize rejects an unknown font_family" do
    raw = Map.put(valid_raw(), "font_family", "comic-sans")
    assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
  end

  test "sanitize accepts every allowed font_family" do
    for font <- TokenModel.font_families() do
      raw = Map.put(valid_raw(), "font_family", font)
      assert {:ok, %{"font_family" => ^font}} = TokenModel.sanitize(raw)
    end
  end

  test "sanitize rejects out-of-range opacity" do
    assert {:error, :invalid_theme} =
             TokenModel.sanitize(put_in(valid_raw(), ["background", "opacity"], 5.0))

    assert {:error, :invalid_theme} =
             TokenModel.sanitize(put_in(valid_raw(), ["background", "opacity"], -0.1))
  end

  test "sanitize accepts an integer opacity by coercing to float" do
    assert {:ok, clean} = TokenModel.sanitize(put_in(valid_raw(), ["background", "opacity"], 1))
    assert clean["background"]["opacity"] === 1.0
  end

  test "sanitize rejects a missing color key" do
    raw = update_in(valid_raw(), ["colors"], &Map.delete(&1, "bg"))
    assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
  end

  test "sanitize rejects a completely bogus shape" do
    assert {:error, :invalid_theme} = TokenModel.sanitize(%{})
    assert {:error, :invalid_theme} = TokenModel.sanitize("not a map")
    assert {:error, :invalid_theme} = TokenModel.sanitize(nil)
  end

  test "sanitize normalizes #rgb to lowercased #rrggbb" do
    raw = put_in(valid_raw(), ["colors", "bg"], "#AbC")
    assert {:ok, clean} = TokenModel.sanitize(raw)
    assert clean["colors"]["bg"] == "#aabbcc"
  end

  test "default_colors covers every color key with valid hex" do
    defaults = TokenModel.default_colors()
    assert Enum.sort(Map.keys(defaults)) == Enum.sort(TokenModel.color_keys())

    raw = %{
      "colors" => defaults,
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }

    assert {:ok, _} = TokenModel.sanitize(raw)
  end

  # #294 — built-in background picker. `background` gains a discriminated
  # `builtin` key (a member of the closed BuiltinBackgrounds catalog, mutually
  # exclusive with an uploads `image_id`) + a forward-compat `size` mode
  # (`cover` default; `repeat` reserved for the next-session tile set).
  describe "#294 built-in background field" do
    defp builtin_key, do: hd(BuiltinBackgrounds.keys())

    test "sanitize accepts a valid built-in key" do
      raw = put_in(valid_raw(), ["background", "builtin"], builtin_key())
      assert {:ok, clean} = TokenModel.sanitize(raw)
      assert clean["background"]["builtin"] == builtin_key()
      assert clean["background"]["image_id"] == nil
    end

    test "sanitize rejects an unknown built-in key (closed set)" do
      raw = put_in(valid_raw(), ["background", "builtin"], "99-not-a-real-bg")
      assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
    end

    test "sanitize rejects a path-traversal built-in key" do
      raw = put_in(valid_raw(), ["background", "builtin"], "../../etc/passwd")
      assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
    end

    test "sanitize rejects image_id AND builtin set together (mutually exclusive)" do
      raw =
        valid_raw()
        |> put_in(["background", "image_id"], String.duplicate("a", 26))
        |> put_in(["background", "builtin"], builtin_key())

      assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
    end

    test "sanitize defaults size to cover when absent (backward-compat old payloads)" do
      assert {:ok, clean} = TokenModel.sanitize(valid_raw())
      assert clean["background"]["size"] == "cover"
    end

    test "sanitize defaults builtin to nil when absent (backward-compat old payloads)" do
      assert {:ok, clean} = TokenModel.sanitize(valid_raw())
      assert clean["background"]["builtin"] == nil
    end

    test "sanitize accepts the repeat size mode" do
      raw = put_in(valid_raw(), ["background", "size"], "repeat")
      assert {:ok, clean} = TokenModel.sanitize(raw)
      assert clean["background"]["size"] == "repeat"
    end

    test "sanitize rejects an unknown size mode" do
      raw = put_in(valid_raw(), ["background", "size"], "stretch")
      assert {:error, :invalid_theme} = TokenModel.sanitize(raw)
    end

    test "sanitize canonicalises background to exactly image_id/builtin/size/opacity" do
      raw = put_in(valid_raw(), ["background", "builtin"], builtin_key())
      assert {:ok, clean} = TokenModel.sanitize(raw)
      assert Enum.sort(Map.keys(clean["background"])) == ~w(builtin image_id opacity size)
    end
  end
end
