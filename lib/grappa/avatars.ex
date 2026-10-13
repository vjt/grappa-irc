defmodule Grappa.Avatars do
  @moduledoc """
  M3b — bouncer-wide, SSRF-hardened cache of a PEER's CTCP AVATAR image,
  per `(network, folded nick)`.

  ## Why this is a separate context from `Grappa.Uploads`

  A subject-owned permanent upload (`Grappa.Uploads`) and a best-effort
  cache of a fetched, untrusted stranger's image are different trust
  domains: one is content OUR user chose to publish (public, permanent,
  no expiry by default); the other is content a PEER claimed a URL for,
  fetched by US, on THEIR behalf, never to be treated as authoritative or
  permanent. CLAUDE.md: a shared data model with a type flag across two
  trust domains is a boundary violation, not reuse — hence a separate
  schema (`Grappa.Avatars.PeerAvatar`) even though the on-disk mechanics
  (slug filename under a storage root) mirror `Grappa.Uploads` closely.

  ## The fetch is never triggered by the browser

  `Grappa.Session.EventRouter` parses a peer's CTCP AVATAR reply and
  calls `fetch_and_cache/3` inside a detached `Grappa.TaskSupervisor`
  task — see that module's `maybe_query_avatar/2` / the AVATAR-reply
  parsing clause. The URL a peer supplies is fully untrusted; the
  browser NEVER sees it or fetches it directly (see
  `docs/DESIGN_NOTES.md` #1280). `fetch_and_cache/3` is the entire SSRF
  boundary: scheme + SSRF-safe DNS resolution + no-redirect-follow (all
  three courtesy of reusing `Grappa.Net.ImageFetcher` — see below),
  a magic-byte content sniff on top of that, `Grappa.Uploads.
  MetadataStrip` for the same EXIF/GPS privacy reason a user's OWN
  upload gets stripped, and a disk-budget cap.

  ## Reusing `Grappa.Net.ImageFetcher`, deliberately

  "Fetch a raster image by URL, safely" is the SAME verb this app
  already built and hardened for the theme-background-image feature
  (#75): `Grappa.Net.Ssrf.resolve_safe/1` resolves the host once, DNS-
  rebind-safe (dials the resolved IP with `Host`/SNI still set to the
  original hostname), never follows a redirect (a second, unguarded hop
  would be an SSRF bypass — so refusing outright, not chasing a bounded
  number of hops, is the SAFER and simpler posture this module inherits
  rather than reinventing), and enforces a raster content-type allowlist
  + byte cap. Duplicating that as a second SSRF implementation for
  avatars would be exactly the "same problem, two solutions" CLAUDE.md
  rejects — this module calls the SAME configured module (`Application.
  get_env(:grappa, :themes)[:image_fetcher]`, read at boot), so a test can
  swap in `Grappa.Net.ImageFetcherMock` for BOTH features with one
  seam. The one thing this module adds ON TOP, because a peer-declared
  URL is materially more adversarial than a URL an authenticated user
  pastes into their own theme picker: a magic-byte sniff of the
  downloaded bytes (`sniff_image_mime/1`), not just trusting the
  fetcher's already-allowlisted `Content-Type` header.

  ## Boundary

  Top-level. Deps: `Repo`, `Uploads` (MetadataStrip only — no schema
  dep), `Net.ImageFetcher`, `PubSub`. Deliberately NO `Networks` dep:
  `PeerAvatar.network_id` is a plain integer field, not a `belongs_to`
  association — `Grappa.Networks` already depends on `Grappa.Session`,
  and `Grappa.Session` depends on THIS module, so a `Networks` edge here
  would close a cycle (see `PeerAvatar`'s schema comment).
  `TaskSupervisor` is referenced by callers (`Session`), not by this
  module.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Uploads, Grappa.Net.ImageFetcher, Grappa.PubSub],
    exports: [PeerAvatar]

  import Ecto.Query

  alias Grappa.Avatars.PeerAvatar
  alias Grappa.Net.ImageFetcher
  alias Grappa.Repo
  alias Grappa.Uploads.MetadataStrip

  require Logger

  @slug_byte_size 16
  @slug_regex ~r/\A[a-z2-7]{26}\z/

  @storage_root_key {__MODULE__, :storage_root}
  @fetcher_key {__MODULE__, :image_fetcher}

  # A cached peer avatar is a speculative, stale-tolerant preview — not
  # a permanent asset. A few days balances "don't re-fetch on every
  # WHOIS" against "don't serve a years-stale image forever."
  @ttl_seconds 5 * 24 * 60 * 60

  # Global disk budget for this cache — deliberately small relative to
  # `Grappa.Uploads`' cap: unlike a user's own uploads (bounded by how
  # much THEY choose to upload), this cache grows from OTHER people's
  # claimed URLs, so it needs its own tight ceiling independent of the
  # uploads budget.
  @global_cap_bytes 200 * 1024 * 1024
  # Per-entry ceiling, handed to the fetcher so a bigger body is cut off
  # while it streams (#2402) — and what keeps `check_global_cap/0`'s
  # pre-estimate of the incoming write true.
  @max_fetch_bytes 2 * 1024 * 1024

  @doc """
  Boot-time injection — mirrors `Grappa.Uploads.boot/1` for the storage
  root, and `Themes.BackgroundImage.boot/0` for the image-fetcher DI
  seam (#364 J/cross-module-S2): the fetcher is read from
  `config :grappa, :themes` ONCE here and stashed in `:persistent_term`
  for lock-free runtime reads, never per call.
  """
  @spec boot(Path.t()) :: :ok
  def boot(path) when is_binary(path) do
    fetcher =
      :grappa
      |> Application.get_env(:themes, [])
      |> Keyword.get(:image_fetcher, ImageFetcher.Req)

    :persistent_term.put(@fetcher_key, fetcher)
    :persistent_term.put(@storage_root_key, path)
    :ok
  end

  @spec storage_root() :: Path.t()
  def storage_root, do: :persistent_term.get(@storage_root_key)

  # DI seam read at BOOT into `:persistent_term` by `boot/1` and resolved
  # lock-free here — the SAME `config :grappa, :themes` key
  # `Themes.BackgroundImage` reads, so one Mox seam covers both features.
  # The config value stays a module atom read from env — never a
  # `compile_env` module attribute — or the runtime-generated mock
  # (`Grappa.Net.ImageFetcherMock`, defined in `test_helper.exs`) becomes
  # a compile-time "module not available" warning, which
  # `--warnings-as-errors` turns into a red build. `get/2` defaults to the
  # real impl, degrading gracefully before `boot/1` runs.
  defp fetcher, do: :persistent_term.get(@fetcher_key, ImageFetcher.Req)

  @doc """
  Fetch `url` (a peer's CTCP AVATAR reply) for `(network_id, nick_key)`
  and, on success, cache the sanitized bytes. `nick_key` MUST already be
  folded (`Grappa.IRC.Identifier.canonical_target/1`) — this module does
  not fold, the caller (`EventRouter`) owns that per the codebase's
  nick-key invariant.

  Meant to run inside a detached `Task.Supervisor.start_child(Grappa.
  TaskSupervisor, fn -> ... end)` — never inline in a GenServer mailbox
  (it's a blocking HTTP round-trip). Every failure is swallowed (logged,
  not raised) — this is best-effort peer enrichment, never a
  user-facing error.

  On success, broadcasts `{:peer_avatar_ready, network_id, nick_key,
  slug}` on `Grappa.PubSub.Topic.peer_avatar_cache/1` so a live
  `Session.Server` can fold the result into its `peer_profile_cache`
  and push an incremental WHOIS-card update.
  """
  @spec fetch_and_cache(integer(), String.t(), String.t()) :: :ok
  def fetch_and_cache(network_id, nick_key, url)
      when is_integer(network_id) and is_binary(nick_key) and is_binary(url) do
    with :ok <- check_global_cap(),
         {:ok, bytes, content_type} <- fetcher().fetch(url, @max_fetch_bytes),
         :ok <- sniff_image_mime(bytes, content_type),
         {:ok, stripped} <- MetadataStrip.run(bytes, content_type),
         {:ok, row} <- store(network_id, nick_key, stripped, content_type) do
      :ok = broadcast_ready(network_id, nick_key, row.slug)
      :ok
    else
      {:error, reason} ->
        Logger.info(
          "avatars: peer avatar fetch skipped network_id=#{network_id} nick=#{nick_key} reason=#{inspect(reason)}"
        )

        :ok
    end
  end

  @spec check_global_cap() :: :ok | {:error, :insufficient_storage}
  defp check_global_cap do
    query = from(a in PeerAvatar, select: coalesce(sum(a.bytes), 0))

    if Repo.one(query) + @max_fetch_bytes > @global_cap_bytes do
      {:error, :insufficient_storage}
    else
      :ok
    end
  end

  # Real magic-byte signatures, not the claimed `Content-Type` header —
  # The fetcher already allowlisted the header, but a peer-declared URL is
  # adversarial enough to warrant checking the bytes actually ARE what
  # they claim to be before they reach exiftool/disk.
  @spec sniff_image_mime(binary(), String.t()) :: :ok | {:error, :content_mismatch}
  defp sniff_image_mime(<<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, _::binary>>, "image/png"), do: :ok
  defp sniff_image_mime(<<0xFF, 0xD8, 0xFF, _::binary>>, "image/jpeg"), do: :ok
  defp sniff_image_mime(<<"GIF87a", _::binary>>, "image/gif"), do: :ok
  defp sniff_image_mime(<<"GIF89a", _::binary>>, "image/gif"), do: :ok
  defp sniff_image_mime(<<"RIFF", _::binary-size(4), "WEBP", _::binary>>, "image/webp"), do: :ok
  defp sniff_image_mime(_, _), do: {:error, :content_mismatch}

  defp store(network_id, nick_key, bytes, mime) do
    slug = mint_slug()
    path = storage_path(slug)

    with :ok <- File.mkdir_p(storage_root()),
         :ok <- File.write(path, bytes) do
      insert_or_replace(network_id, nick_key, slug, mime, byte_size(bytes))
    else
      {:error, posix} -> {:error, {:fs, posix}}
    end
  end

  # Replaces any prior cached row for this (network, nick): unlink the
  # OLD file first (mirrors `Grappa.Uploads.Reaper`'s file-first ordering
  # — a racing serve sees the row live + ENOENT rather than a dangling
  # reference), then upsert the new row on the unique
  # `(network_id, nick_key)` index.
  defp insert_or_replace(network_id, nick_key, slug, mime, bytes) do
    _ =
      case Repo.get_by(PeerAvatar, network_id: network_id, nick_key: nick_key) do
        %PeerAvatar{slug: old_slug} when old_slug != slug ->
          File.rm(storage_path(old_slug))

        _ ->
          :ok
      end

    attrs = %{
      network_id: network_id,
      nick_key: nick_key,
      slug: slug,
      mime: mime,
      bytes: bytes,
      expires_at: DateTime.add(DateTime.utc_now(), @ttl_seconds, :second)
    }

    %PeerAvatar{}
    |> PeerAvatar.insert_changeset(attrs)
    |> Repo.insert(
      on_conflict: {:replace, [:slug, :mime, :bytes, :expires_at, :updated_at]},
      conflict_target: [:network_id, :nick_key]
    )
  end

  defp broadcast_ready(network_id, nick_key, slug) do
    Phoenix.PubSub.broadcast(
      Grappa.PubSub,
      Grappa.PubSub.Topic.peer_avatar_cache(network_id),
      {:peer_avatar_ready, network_id, nick_key, slug}
    )
  end

  @doc """
  Looks up the cached row for `(network_id, nick_key)`, `nil` when
  absent or expired. Used by `Session.Server` to seed `whois_bundle`'s
  `avatar_url` synchronously when a fetch already landed before the
  WHOIS was requested.
  """
  @spec get(integer(), String.t()) :: PeerAvatar.t() | nil
  def get(network_id, nick_key) when is_integer(network_id) and is_binary(nick_key) do
    now = DateTime.utc_now()

    query =
      from a in PeerAvatar,
        where: a.network_id == ^network_id and a.nick_key == ^nick_key and a.expires_at > ^now

    Repo.one(query)
  end

  @doc """
  Looks up a row by `(network_id, slug)` for the authenticated serving
  route. Returns `:not_found` for a bad slug shape, a missing row, an
  expired one, or a row belonging to a DIFFERENT network — collapsed to
  one variant so the serving route leaks no oracle.

  `network_id` is not redundant with the slug. The serving route is
  mounted under `/networks/:network_id/...` behind `ResolveNetwork`,
  which proves the caller holds a credential on THAT network and nothing
  more; the action's own contract is "any live credential on this
  network". A slug-only lookup would have made every cached row on the
  deployment readable from any one network the caller is bound to, which
  is a wider grant than the route's own gate proves — so the conjunct
  here is what makes the documented scope true rather than aspirational.
  Mirrors `get/2`, which has been `(network_id, nick_key)`-scoped from
  the start.
  """
  @spec get_by_slug(integer(), String.t()) :: {:ok, PeerAvatar.t()} | {:error, :not_found}
  def get_by_slug(network_id, slug) when is_integer(network_id) and is_binary(slug) do
    if Regex.match?(@slug_regex, slug) do
      now = DateTime.utc_now()

      query =
        from a in PeerAvatar,
          where: a.network_id == ^network_id and a.slug == ^slug and a.expires_at > ^now

      case Repo.one(query) do
        nil -> {:error, :not_found}
        row -> {:ok, row}
      end
    else
      {:error, :not_found}
    end
  end

  @doc "Composes the on-disk path for a slug. Mirrors `Grappa.Uploads.storage_path/2`."
  @spec storage_path(String.t()) :: Path.t()
  def storage_path(slug) when is_binary(slug) do
    unless Regex.match?(@slug_regex, slug), do: raise(ArgumentError, "invalid slug shape: #{inspect(slug)}")
    Path.join(storage_root(), slug)
  end

  @spec mint_slug() :: String.t()
  defp mint_slug do
    @slug_byte_size
    |> :crypto.strong_rand_bytes()
    |> Base.encode32(case: :lower, padding: false)
  end

  @doc """
  Rows whose `expires_at` has passed — Reaper enumeration
  (`Grappa.Avatars.Reaper`).
  """
  @spec list_expired(DateTime.t()) :: [PeerAvatar.t()]
  def list_expired(%DateTime{} = now) do
    query = from a in PeerAvatar, where: a.expires_at <= ^now
    Repo.all(query)
  end

  @doc """
  Hard-deletes a row. Unlike `Grappa.Uploads`' soft-delete-then-sweep
  (needed there because a public, cacheable URL can be mid-flight when
  reaped), this cache has no such contract to protect — a stale row is
  simply gone, and the caller (Reaper) unlinks the file first.
  """
  @spec delete(PeerAvatar.t()) :: :ok
  def delete(%PeerAvatar{} = row) do
    Repo.delete!(row)
    :ok
  end
end
