defmodule Grappa.Themes.BuiltinBackgrounds do
  @moduledoc """
  The curated, system-owned catalog of built-in wallpaper images (#294 v1).

  Same ownership model as the built-in themes (`Grappa.Themes.Builtins`): a
  closed, read-only set the operator can't mutate. But unlike theme *rows*
  (DB-materialised, per-owner authz), the images themselves are **static
  assets** — WebP files shipped in the cic bundle under
  `cicchetto/public/backgrounds/`, served by nginx at `/backgrounds/<key>.webp`
  with long-lived cache headers (a new `location` block in
  `infra/snippets/locations-api.conf`). There is no DB blob and no per-image
  authz: immutability + being in the bundle IS the read-only guarantee.

  This module is the SINGLE SOURCE OF TRUTH for the closed key set. It gates
  two doors:

    * `TokenModel.sanitize/1` validates a theme payload's `background.builtin`
      against `keys/0` — an arbitrary string can't ride through into a stored
      theme (safe-by-construction, no path traversal since keys are a fixed
      `[a-z0-9-]` allowlist).
    * `GET /themes/backgrounds` (`GrappaWeb.ThemesController.backgrounds/2`)
      serves `all/0` to the cic picker, so the client never hard-codes the
      catalog (mirrors the `newThemeSeedPayload` "reuse the server's canonical
      set, don't duplicate it" discipline — two copies would drift).

  `path/1` is a pure convention (`/backgrounds/<key>.webp`) so `customTheme.ts`
  can resolve a `builtin` key to a URL synchronously at boot, without a catalog
  fetch — the fetch is only for the picker's display metadata.

  v1 is COVER-only (`background-size: cover`, already the wallpaper CSS mode);
  the tileable `size: "repeat"` pattern set is a next-session follow-up. All 8
  are 1920w WebP: 4 dark + 4 light (the `variant` feeds default-per-theme
  sensibility in the picker).
  """

  @type variant :: :dark | :light
  @type t :: %{key: String.t(), name: String.t(), variant: variant(), path: String.t()}

  # {key, display name, variant}. The key IS the WebP filename stem under
  # cicchetto/public/backgrounds/; `path/1` appends the extension. Order is
  # gallery-display order (dark set, then light set is NOT enforced — this is
  # the vjt v1 manifest order: numbered 01..08).
  @catalog [
    {"01-lain-dark", "Lain", :dark},
    {"02-space-nebula-dark", "Nebula", :dark},
    {"03-forest-night-dark", "Forest Night", :dark},
    {"04-galaxy-pastel-light", "Pastel Galaxy", :light},
    {"05-dawn-hills-light", "Dawn Hills", :light},
    {"06-irc-netsplit-dark", "Netsplit", :dark},
    {"07-irc-trout-light", "Trout", :light},
    {"08-irc-emoticons-light", "Emoticons", :light}
  ]

  @doc "The curated built-in backgrounds, in picker-display order."
  @spec all() :: [t()]
  def all do
    Enum.map(@catalog, fn {key, name, variant} ->
      %{key: key, name: name, variant: variant, path: path(key)}
    end)
  end

  @doc "The flat list of catalog keys (the closed set), in `all/0` order."
  @spec keys() :: [String.t()]
  def keys, do: Enum.map(@catalog, fn {key, _, _} -> key end)

  @doc "The static asset path a `builtin` key resolves to (the cic convention)."
  @spec path(String.t()) :: String.t()
  def path(key) when is_binary(key), do: "/backgrounds/#{key}.webp"

  @doc "Whether `key` is a member of the closed catalog (gates the sanitizer)."
  @spec valid_key?(term()) :: boolean()
  def valid_key?(key) when is_binary(key), do: key in keys()
  def valid_key?(_), do: false
end
