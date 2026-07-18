defmodule Grappa.Themes.TokenModel do
  @moduledoc """
  The canonical, closed theme token vocabulary — and the sanitizer that gates it.

  A theme drives CSS, and CSS is code (exfil via `url()`/`@import` beacons,
  fake-UI overlays, spoofing). Published themes render in every viewer's
  browser, so an unsafe theme is stored-XSS-via-CSS. The defence is
  **safe-by-construction**: the only thing that ever crosses the wire and lands
  in the DB is this closed token vocabulary. Producers (the color-picker UI, the
  built-in seed, a future AI generator per #83) can only express tokens the
  vocabulary allows; `sanitize/1` drops everything else. The renderer
  (cicchetto) generates scoped CSS from this sanitized map — it NEVER consumes
  raw `.theme`/CSS.

  The vocabulary (FROZEN):

    * `"colors"` — a map with EXACTLY the 27 keys in `color_keys/0`, each a
      strict `#rrggbb` hex string (`#rgb` shorthand is accepted and expanded).
    * `"font_family"` — one of `font_families/0` (a curated, self-hosted set;
      no arbitrary fonts, no runtime CDN fetch).
    * `"background"` — `%{"image_id" => uploads-slug | nil, "builtin" =>
      catalog-key | nil, "size" => "cover" | "repeat", "opacity" => 0.0..1.0}`.
      `image_id` (a re-hosted upload) and `builtin` (a member of the
      `BuiltinBackgrounds` closed catalog, #294) are mutually exclusive — at
      most one is non-nil. `size` is COVER by default (`repeat` reserved for the
      next-session tile set). `builtin`/`size` are DEFAULTED when absent, so a
      pre-#294 payload (`image_id`+`opacity` only) sanitizes forward cleanly.

  Font *size* is deliberately NOT a token — it stays a per-client setting to
  avoid two sources of truth (see #75 fork-3 decision).
  """

  alias Grappa.Themes.BuiltinBackgrounds

  @base_color_keys ~w(bg bg_alt fg accent muted border mention mode_op mode_halfop mode_voiced mode_plain)
  @nick_color_keys Enum.map(0..15, &"nick_#{&1}")
  @color_keys @base_color_keys ++ @nick_color_keys

  @font_families ~w(mono-default jetbrains-mono fira-code iosevka hack cascadia-code source-code-pro ibm-plex-mono)

  # Background sizing modes (#294). `cover` = full-bleed (the v1 built-in set +
  # every upload); `repeat` = seamless tile (the deferred pattern set). cic
  # mirrors this closed set in `themesApi.ts`.
  @size_modes ~w(cover repeat)

  # #rgb or #rrggbb, case-insensitive. Nothing else — a value that is not a
  # bare hex color (e.g. `red; }body{}` or `url(http://evil)`) is rejected, so
  # no CSS syntax can ride through a color slot.
  @hex_re ~r/\A#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\z/
  # Uploads mints 26-char base32 (Crockford a-z2-7) slugs; a background image_id
  # must be one of those (a locally re-hosted image) or nil.
  @slug_re ~r/\A[a-z2-7]{26}\z/

  # irssi-dark palette — the historical cicchetto default, reused as the editor
  # starting point and the first built-in.
  @default_colors %{
    "bg" => "#0a0a0a",
    "bg_alt" => "#111111",
    "fg" => "#e0e0e0",
    "accent" => "#5fafd7",
    "muted" => "#707070",
    "border" => "#1f1f1f",
    "mention" => "#2a1f00",
    "mode_op" => "#d77070",
    "mode_halfop" => "#d7af5f",
    "mode_voiced" => "#70d770",
    "mode_plain" => "#e0e0e0",
    "nick_0" => "#ff8c8c",
    "nick_1" => "#ffb060",
    "nick_2" => "#ffd060",
    "nick_3" => "#d8e060",
    "nick_4" => "#90d870",
    "nick_5" => "#60d8a8",
    "nick_6" => "#60d8d8",
    "nick_7" => "#60b8e8",
    "nick_8" => "#88a8ff",
    "nick_9" => "#b890ff",
    "nick_10" => "#e088e0",
    "nick_11" => "#ff90c0",
    "nick_12" => "#e0a888",
    "nick_13" => "#c0c0c0",
    "nick_14" => "#a0e8b8",
    "nick_15" => "#f0d090"
  }

  @type token_map :: %{String.t() => term()}

  @doc "The frozen list of 27 color token keys (string form)."
  @spec color_keys() :: [String.t()]
  def color_keys, do: @color_keys

  @doc "The closed allowlist of font-family keys."
  @spec font_families() :: [String.t()]
  def font_families, do: @font_families

  @doc "The closed allowlist of background sizing modes (#294)."
  @spec size_modes() :: [String.t()]
  def size_modes, do: @size_modes

  @doc "The irssi-dark default palette — every color key mapped to valid hex."
  @spec default_colors() :: %{String.t() => String.t()}
  def default_colors, do: @default_colors

  @doc """
  Validate and normalise an untrusted token map into the canonical model.

  Returns `{:ok, token_map}` with EXACTLY `"colors"`/`"font_family"`/
  `"background"` keys (unknown keys dropped, hex lowercased/expanded), or
  `{:error, :invalid_theme}` when any required token is missing or invalid.
  """
  @spec sanitize(term()) :: {:ok, token_map()} | {:error, :invalid_theme}
  def sanitize(%{"colors" => colors, "font_family" => font, "background" => background})
      when is_map(colors) and is_binary(font) and is_map(background) do
    with {:ok, clean_colors} <- sanitize_colors(colors),
         {:ok, clean_font} <- sanitize_font(font),
         {:ok, clean_background} <- sanitize_background(background) do
      {:ok,
       %{
         "colors" => clean_colors,
         "font_family" => clean_font,
         "background" => clean_background
       }}
    end
  end

  def sanitize(_), do: {:error, :invalid_theme}

  # Collect-or-bail over the closed key set: every color key must be present and
  # valid; unknown keys in the input are never read, so they cannot ride through.
  defp sanitize_colors(colors), do: sanitize_colors(@color_keys, colors, [])
  defp sanitize_colors([], _, acc), do: {:ok, Map.new(acc)}

  defp sanitize_colors([key | rest], colors, acc) do
    with {:ok, raw} <- Map.fetch(colors, key),
         {:ok, hex} <- normalize_hex(raw) do
      sanitize_colors(rest, colors, [{key, hex} | acc])
    else
      _ -> {:error, :invalid_theme}
    end
  end

  defp normalize_hex(value) when is_binary(value) do
    if Regex.match?(@hex_re, value), do: {:ok, expand_hex(value)}, else: :error
  end

  defp normalize_hex(_), do: :error

  defp expand_hex(<<"#", r::binary-size(1), g::binary-size(1), b::binary-size(1)>>) do
    String.downcase("#" <> r <> r <> g <> g <> b <> b)
  end

  defp expand_hex(hex), do: String.downcase(hex)

  defp sanitize_font(font) when font in @font_families, do: {:ok, font}
  defp sanitize_font(_), do: {:error, :invalid_theme}

  # `opacity` is the one always-required key; `image_id`/`builtin`/`size` are
  # read via `Map.get` so a pre-#294 payload (no `builtin`/`size`) sanitizes
  # forward to the canonical 4-key shape. `image_id` and `builtin` are mutually
  # exclusive (a background is EITHER an upload OR a built-in, never both).
  defp sanitize_background(%{"opacity" => opacity} = bg) do
    with {:ok, id} <- sanitize_image_id(Map.get(bg, "image_id")),
         {:ok, builtin} <- sanitize_builtin(Map.get(bg, "builtin")),
         {:ok, size} <- sanitize_size(Map.get(bg, "size")),
         {:ok, op} <- sanitize_opacity(opacity),
         :ok <- reject_dual_source(id, builtin) do
      {:ok, %{"image_id" => id, "builtin" => builtin, "size" => size, "opacity" => op}}
    end
  end

  defp sanitize_background(_), do: {:error, :invalid_theme}

  defp sanitize_image_id(nil), do: {:ok, nil}

  defp sanitize_image_id(id) when is_binary(id) do
    if Regex.match?(@slug_re, id), do: {:ok, id}, else: {:error, :invalid_theme}
  end

  defp sanitize_image_id(_), do: {:error, :invalid_theme}

  # A built-in reference is a member of the closed catalog or nil — an unknown
  # key (or a path-traversal attempt) is rejected, never resolved to an asset.
  defp sanitize_builtin(nil), do: {:ok, nil}

  defp sanitize_builtin(key) when is_binary(key) do
    if BuiltinBackgrounds.valid_key?(key), do: {:ok, key}, else: {:error, :invalid_theme}
  end

  defp sanitize_builtin(_), do: {:error, :invalid_theme}

  # Absent size defaults to cover (backward-compat + the v1 default).
  defp sanitize_size(nil), do: {:ok, "cover"}
  defp sanitize_size(size) when size in @size_modes, do: {:ok, size}
  defp sanitize_size(_), do: {:error, :invalid_theme}

  # A theme carries at most one background source.
  defp reject_dual_source(nil, _), do: :ok
  defp reject_dual_source(_, nil), do: :ok
  defp reject_dual_source(_, _), do: {:error, :invalid_theme}

  defp sanitize_opacity(opacity) when is_integer(opacity), do: sanitize_opacity(opacity * 1.0)

  defp sanitize_opacity(opacity) when is_float(opacity) and opacity >= 0.0 and opacity <= 1.0,
    do: {:ok, opacity}

  defp sanitize_opacity(_), do: {:error, :invalid_theme}
end
