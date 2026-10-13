defmodule Grappa.Net.ImageFetcher do
  @moduledoc """
  Behaviour for fetching a theme background image BY URL (#75).

  Fetch-by-URL is the SSRF-exposed half of the background-image pipeline: a
  user-supplied URL that the SERVER dials. The real implementation
  (`Grappa.Net.ImageFetcher.Req`) resolves the host through
  `Grappa.Net.Ssrf` and connects to the *resolved* IP (rebind-safe), enforces a
  raster-only content-type allowlist, and caps the download at the byte limit
  the CALLER passes — while the body streams, never after buffering it —
  never raising, always returning a tagged error. The limit is the caller's
  because the callers disagree on it: a theme background and a peer avatar
  are different budgets (#2402).

  Isolating the network call behind a behaviour lets tests inject a
  deterministic mock (`Grappa.Net.ImageFetcherMock`, wired via
  `config :grappa, :themes, image_fetcher: …`) instead of standing up a real
  socket. `Grappa.Themes.BackgroundImage` resolves the configured module at
  runtime and calls `fetch/1`.

  ## Move history (M3b)

  Originally `Grappa.Themes.ImageFetcher` — relocated here so
  `Grappa.Avatars` (the M3b peer-avatar cache) could reuse this SAME
  SSRF-hardened fetch-by-URL behaviour for CTCP AVATAR URLs without
  creating a Boundary dependency cycle (`Session → Avatars → Themes →
  Networks → Session`, since `Grappa.Themes` itself depends on
  `Grappa.Networks`). "Fetch a raster image by URL, safely" is a
  network-safety primitive, not a themes concern — it belongs beside
  `Grappa.Net.Ssrf`, which it wraps. The config key stays under
  `:themes, :image_fetcher` (unchanged) rather than churning every
  caller's DI seam for a purely-cosmetic rename.
  """

  use Boundary, top_level?: true, deps: [Grappa.Net.Ssrf], exports: [Req]

  @raster_content_types ~w(image/png image/jpeg image/gif image/webp)

  @doc """
  The allowed raster response content-types. NO SVG — SVG is scriptable XML, not
  a raster image, and would defeat the "re-encode to a flat PNG" defence.
  """
  @spec raster_content_types() :: [String.t()]
  def raster_content_types, do: @raster_content_types

  @typedoc "Raster image bytes plus the (already-validated) response content-type."
  @type ok :: {:ok, binary(), content_type :: String.t()}

  @typedoc """
  Why a fetch was refused:

    * `:ssrf_blocked`  — the host resolved to a private/loopback/metadata address.
    * `:not_raster`    — the response content-type is not an allowed raster image.
    * `:too_large`     — the declared or received body passed the caller's cap.
    * `:fetch_failed`  — DNS/connect/HTTP transport failure, redirect, or bad URL.
  """
  @type error :: {:error, :ssrf_blocked | :not_raster | :too_large | :fetch_failed}

  @callback fetch(url :: String.t(), max_bytes :: pos_integer()) :: ok() | error()
end
