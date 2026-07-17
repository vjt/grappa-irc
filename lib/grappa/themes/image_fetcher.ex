defmodule Grappa.Themes.ImageFetcher do
  @moduledoc """
  Behaviour for fetching a theme background image BY URL (#75).

  Fetch-by-URL is the SSRF-exposed half of the background-image pipeline: a
  user-supplied URL that the SERVER dials. The real implementation
  (`Grappa.Themes.ImageFetcher.Req`) resolves the host through
  `Grappa.Net.Ssrf` and connects to the *resolved* IP (rebind-safe), enforces a
  raster-only content-type allowlist, and caps the download size — never
  raising, always returning a tagged error.

  Isolating the network call behind a behaviour lets tests inject a
  deterministic mock (`Grappa.Themes.ImageFetcherMock`, wired via
  `config :grappa, :themes, image_fetcher: …`) instead of standing up a real
  socket. `Grappa.Themes.BackgroundImage` resolves the configured module at
  runtime and calls `fetch/1`.
  """

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
    * `:too_large`     — the body exceeded the download cap.
    * `:fetch_failed`  — DNS/connect/HTTP transport failure, redirect, or bad URL.
  """
  @type error :: {:error, :ssrf_blocked | :not_raster | :too_large | :fetch_failed}

  @callback fetch(url :: String.t()) :: ok() | error()
end
