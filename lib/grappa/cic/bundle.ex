defmodule Grappa.Cic.Bundle do
  @moduledoc """
  Single source of truth for the deployed cic bundle hash + version.

  Reads `runtime/cicchetto-dist/index.html` on every call and parses
  the Vite-emitted `<script src="/assets/index-<hash>.js">` tag. The
  hash changes every cic build, so a `compose --profile prod run --rm
  cicchetto-build` lands the next call's hash without server restart
  or hot-reload — same live-read pattern as `Grappa.Version` (CP23 S3
  memory `feedback_live_read_disk_for_hot_reload`).

  #292 adds `current_version/0`: the human-readable semver Vite bakes
  into the same `index.html` as a `<meta name="cicchetto-version">`
  tag (from `cicchetto/package.json`). The refresh banner shows
  "current X → available Y" — the *available* semver is read here, from
  the DEPLOYED dist (not the source `package.json`), so the server
  advertises what is actually served. The hash is still the trigger
  (a trivial rebuild reuses the semver); the version is display
  enrichment. When two builds share a semver (no bump), cic appends the
  short bundle hash so the "changed" signal never goes dead.

  Returns `nil` when the file is absent (dev without a cic build, test
  env, prod before the first cicchetto-build oneshot completes), and
  `current_version/0` also returns `nil` for a bundle built before the
  meta tag existed. The user-topic join push (B4) and refresh-banner
  broadcast (B5) treat a `nil` hash as "no bundle to compare against"
  and skip the push; a `nil` version rides the wire as an omitted key
  (cic falls back to the build-hash display).

  Standalone boundary so both `GrappaWeb.GrappaChannel` (after_join
  push) and `GrappaWeb.AdminController.cic_bundle_changed/2` (re-read
  + broadcast) can call this without crossing forbidden boundary
  edges.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Compile-time anchor — `lib/grappa/cic/` → repo root → `runtime/`.
  # The bind-mount model (`./:/app`) keeps the file on disk; per-call
  # `File.read/1` is fine — `index.html` is small + page-cached.
  @bundle_path Path.expand("../../../runtime/cicchetto-dist/index.html", __DIR__)

  # Vite emits `<script type="module" crossorigin src="/assets/index-<hash>.js">`.
  # The hash is the chunk-content fingerprint; bumps on every build that
  # produces different bytes. `[^."]+` excludes the `.js` suffix and any
  # accidental quote.
  @hash_re ~r{<script[^>]+src="/assets/index-([^."]+)\.js"}

  # Vite injects `<meta name="cicchetto-version" content="<semver>">` via
  # the `transformIndexHtml` hook in `cicchetto/vite.config.ts` (attrs in
  # a deterministic `name`-then-`content` order). The semver is the
  # `cicchetto/package.json` version, baked at build. `[^"]+` captures the
  # content up to the closing quote.
  @version_re ~r{<meta[^>]+name="cicchetto-version"[^>]+content="([^"]+)"}

  @doc """
  Returns the current cic bundle hash, or `nil` if the bundle is absent.
  """
  @spec current_hash() :: String.t() | nil
  def current_hash do
    case File.read(@bundle_path) do
      {:ok, html} -> parse_hash(html)
      {:error, _} -> nil
    end
  end

  @doc """
  Returns the current cic bundle semver (from the deployed dist's
  `<meta name="cicchetto-version">` tag), or `nil` if the bundle is
  absent or predates the meta tag.
  """
  @spec current_version() :: String.t() | nil
  def current_version do
    case File.read(@bundle_path) do
      {:ok, html} -> parse_version(html)
      {:error, _} -> nil
    end
  end

  @doc """
  Parses a Vite-emitted `index.html` string and returns the bundle hash.

  Exposed for unit tests + as the pure parsing core of `current_hash/0`.
  """
  @spec parse_hash(binary()) :: String.t() | nil
  def parse_hash(html) when is_binary(html) do
    case Regex.run(@hash_re, html, capture: :all_but_first) do
      [hash] when is_binary(hash) and hash != "" -> hash
      _ -> nil
    end
  end

  @doc """
  Parses a Vite-emitted `index.html` string and returns the bundle
  semver from the `<meta name="cicchetto-version">` tag.

  Exposed for unit tests + as the pure parsing core of `current_version/0`.
  """
  @spec parse_version(binary()) :: String.t() | nil
  def parse_version(html) when is_binary(html) do
    case Regex.run(@version_re, html, capture: :all_but_first) do
      [version] when is_binary(version) and version != "" -> version
      _ -> nil
    end
  end
end
