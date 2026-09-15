defmodule Grappa.Uploads do
  @moduledoc """
  Server-hosted image upload context — UX-6 bucket B1 (2026-05-20).

  ## Why this exists

  Pre-bucket-B, image uploads went directly from the browser to
  `litterbox.catbox.moe` (the I-cluster I-1 design). vjt's 2026-05-20
  iPhone-dogfood revealed catbox unreliable; the post-A-v6 pivot
  picked self-hosted storage over third-party retries.

  The trade-off is: grappa now stores image bytes on disk + serves
  them on demand (operator's IP leaks to viewers since the URL is
  same-origin), in exchange for reliability (uptime tracks grappa's
  own uptime, not litterbox's). catbox stays selectable via the
  admin Settings tab — embedded is the new default.

  ## Public surface

    * `create/3` — accepts `{file_bytes, attrs, opts}`, strips
      image/video metadata (`MetadataStrip` — fail-closed, #39),
      writes to disk, inserts row. `attrs` carries the subject (XOR
      user/visitor FK), `mime`, optional `charset`, optional
      `original_filename`,
      optional `expires_at`. `opts` carries `:storage_root` (DI for
      tests) + the random-slug + clock injection seams.
    * `get_by_slug/1` — slug → `{:ok, %Upload{}} | {:error, :not_found}`.
      Respects soft-delete + expiry: an expired or soft-deleted row
      reads as `:not_found` so the public GET surface has no oracle.
    * `live_bytes_sum/0` — `SUM(bytes) WHERE deleted_at IS NULL`,
      the instance-wide total the admin surface reports.
    * `check_caps/3` — the admission check every write door calls:
      the global disk budget AND the caller's own per-subject quota
      (issue 2175), both refused as `:insufficient_storage`.
    * `list_expired/0` — Reaper enumeration: rows with
      `expires_at <= now()` AND `deleted_at IS NULL`.
    * `soft_delete/2` — flips `deleted_at`. The caller MUST `File.rm/1`
      the on-disk file FIRST (Reaper does this in `sweep/0`).
    * `delete_all_for_subject/1` — HARD-deletes a departing subject's
      uploads, bytes first. Called from the two chokepoints every
      subject-destroying door funnels through, because the FK cascade
      takes the rows and leaves the files (issue 1890).
    * `storage_path/2` — joins `storage_root` + slug, base32-validates
      the slug. Used by `create/3` to write, by the controller to
      read, by Reaper to unlink.
    * `list_all/0` — admin REST enumeration (descending insert time,
      includes soft-deleted rows since admins want the full picture).

  ## Why slug = on-disk filename

  Slugs are 26-char base32 strings derived from 16 random bytes —
  URL-safe, filesystem-safe, no path-separators by construction. A
  validator at every read site (`storage_path/2`) rejects any string
  that isn't `^[a-z2-7]{26}$` before letting it become a filesystem
  reference. Same name everywhere = one less moving part to mismap.

  ## File-first, row-after invariant on writes; file-after, row-first on reads

  - `create/3` writes the file to disk BEFORE inserting the row.
    Rationale: if the row is inserted first then file write fails,
    the row dangles (a `GET /uploads/:slug` returns 200 from the row
    but the file has gone away). File-first means a write failure
    surfaces immediately and the row is never created — no dangling
    state.
  - `Reaper.sweep/2` unlinks the file FIRST, then soft-deletes the
    row. Rationale: between unlink + soft-delete, a racing GET sees
    the row live + ENOENT on disk → returns 404. Inverse ordering
    (soft-delete first, file last) would let the racing GET see
    `deleted_at` set → return 404 → operator browser caches the 404
    → file is still on disk but unreachable for the cache lifetime.
    File-first respects "the bytes are the source of truth."

  ## Boundary

  Deps: `Grappa.Repo`, `Grappa.Subject`, `Grappa.Sys.HardenedCmd`
  (`MetadataStrip` shells out through the shared hardened runner). NOT
  `Grappa.ServerSettings` (caps are passed in by the controller —
  Uploads context is pure persistence + filesystem; cap policy lives at
  the boundary).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Subject, Grappa.Sys.HardenedCmd],
    # M3b — `MetadataStrip` exported so `Grappa.Avatars` can reuse the
    # SAME EXIF/GPS privacy-strip pipeline for fetched peer avatars, not
    # just uploaded bytes — one privacy guarantee, two doors in.
    exports: [MetadataStrip, Upload]

  import Ecto.Query

  alias Grappa.{Repo, Subject}
  alias Grappa.Uploads.{ContentType, MetadataStrip, Upload}

  require Logger

  @slug_byte_size 16
  @slug_regex ~r/\A[a-z2-7]{26}\z/

  @storage_root_key {__MODULE__, :storage_root}
  @base_url_key {__MODULE__, :base_url}

  @doc """
  Boot-time storage-root injection. Called once from the application
  supervisor at boot. Stores the path in `:persistent_term`
  so the controller + Reaper read it lock-free at runtime without
  hitting `Application.get_env/2` (CLAUDE.md "Application.{put,get}
  _env: boot-time only — runtime banned").

  Idempotent; later calls overwrite.
  """
  @spec boot(Path.t()) :: :ok
  def boot(path) when is_binary(path) do
    :persistent_term.put(@storage_root_key, path)
    :ok
  end

  @doc """
  Read the configured storage root. Raises if `boot/1` hasn't run —
  any caller that reaches this without prior boot is a bug.
  """
  @spec storage_root() :: Path.t()
  def storage_root, do: :persistent_term.get(@storage_root_key)

  @doc """
  M3a — boot-time public base URL injection (e.g. `GrappaWeb.Endpoint.url()`,
  seeded once from `application.ex` `start/2` — the same documented
  boot boundary as `boot/1` above, CLAUDE.md "non-process DI-seams").

  Exists because `public_url/2` below needs an ABSOLUTE URL — it feeds
  the CTCP AVATAR reply (`Grappa.Session.EventRouter`), plain text sent
  to an arbitrary remote IRC client with no origin context of its own,
  unlike the JSON wire response (where cic resolves a relative path
  against its own same-origin fetch fine). A `Grappa.Networks`/
  `Grappa.Session` CONTEXT reaching into `GrappaWeb.Endpoint` directly
  would cross the web/context boundary this codebase otherwise keeps
  clean (no `Grappa.*` module outside `application.ex` touches
  `GrappaWeb.Endpoint` — verified before adding this). Idempotent;
  later calls overwrite.
  """
  @spec boot_base_url(String.t()) :: :ok
  def boot_base_url(url) when is_binary(url) do
    :persistent_term.put(@base_url_key, url)
    :ok
  end

  @doc """
  Read the configured public base URL. Raises if `boot_base_url/1`
  hasn't run — any caller that reaches this without prior boot is a bug.
  """
  @spec base_url() :: String.t()
  def base_url, do: :persistent_term.get(@base_url_key)

  @type create_attrs :: %{
          required(:subject) => Subject.t(),
          required(:mime) => String.t(),
          optional(:charset) => ContentType.charset() | nil,
          optional(:bytes) => non_neg_integer(),
          optional(:original_filename) => String.t() | nil,
          optional(:expires_at) => DateTime.t() | nil
        }

  @type create_opts :: [
          storage_root: Path.t(),
          slug: String.t(),
          now: DateTime.t()
        ]

  @doc """
  Generate a fresh slug — 16 random bytes base32-encoded (26 chars,
  no padding, lowercased). 128 bits of entropy.
  """
  @spec mint_slug() :: String.t()
  def mint_slug do
    @slug_byte_size
    |> :crypto.strong_rand_bytes()
    |> Base.encode32(case: :lower, padding: false)
  end

  @doc """
  Validates a slug shape (26 chars of lowercase base32). Returns
  `:ok` or `:error` — the controller maps `:error` to 404 so the
  public GET surface has no oracle for "bad slug" vs "unknown slug."
  """
  @spec valid_slug?(String.t()) :: boolean()
  def valid_slug?(slug) when is_binary(slug), do: Regex.match?(@slug_regex, slug)
  def valid_slug?(_), do: false

  @doc """
  The canonical file extension for an accepted upload MIME as
  `{:ok, ext}` (no leading dot), or `:error` for an unmapped MIME.
  `UploadsController.public_url/2` uses it to mint `/uploads/<slug>.<ext>`
  so the URL carries the media type (#418). Single source of truth:
  `Grappa.Uploads.MimeExt`.
  """
  @spec ext_for(term()) :: {:ok, String.t()} | :error
  defdelegate ext_for(mime), to: __MODULE__.MimeExt

  @doc """
  M3a — the absolute public URL for a stored upload
  (`<base_url>/uploads/<slug>.<ext>`, #418's type-carrying extension).
  Moved here (from what used to be `UploadsController`'s private
  `public_url/2`) so a non-web caller — `Grappa.Networks.Wire.avatar_url/1`,
  which needs the SAME absolute shape for the CTCP AVATAR reply — has one
  place to get it, instead of a second hand-rolled copy. `UploadsController`
  now delegates here too. An unmapped MIME degrades to an extensionless
  URL, matching the pre-move behaviour exactly.
  """
  @spec public_url(String.t(), String.t()) :: String.t()
  def public_url(slug, mime) when is_binary(slug) and is_binary(mime) do
    base = base_url() <> "/uploads/" <> slug

    case ext_for(mime) do
      {:ok, ext} -> base <> "." <> ext
      :error -> base
    end
  end

  @doc """
  Split a client-declared content type into `{mime, charset}`, the
  charset reduced to a closed set of atoms (`nil` when absent or
  unrecognised). The upload boundary matches `mime` against its
  allowlist and persists `charset` beside it. Single source of truth:
  `Grappa.Uploads.ContentType`.
  """
  @spec parse_content_type(String.t()) :: {String.t(), ContentType.charset() | nil}
  defdelegate parse_content_type(raw), to: __MODULE__.ContentType, as: :parse

  @doc """
  Rebuild a `content-type` header value from a stored `{mime, charset}`
  pair, re-spelling the charset canonically. The client's own parameter
  run is never stored and never echoed (#1256).
  """
  @spec content_type_header(String.t(), ContentType.charset() | nil) :: String.t()
  defdelegate content_type_header(mime, charset), to: __MODULE__.ContentType, as: :header

  @doc """
  Compose the on-disk path for a slug. Validates the slug shape at
  the boundary — any non-conforming string raises so the caller
  can't smuggle a `..` traversal through.
  """
  @spec storage_path(Path.t(), String.t()) :: Path.t()
  def storage_path(storage_root, slug) when is_binary(slug) do
    unless valid_slug?(slug), do: raise(ArgumentError, "invalid slug shape: #{inspect(slug)}")
    Path.join(storage_root, slug)
  end

  @doc """
  Strip metadata, write the result to disk + insert a row. Returns
  the inserted row or an error.

  Image + video bytes go through `MetadataStrip.run/2` BEFORE the
  file write — the privacy guarantee (#39) lives here in the
  context so every door (REST controller, future listener facade)
  inherits it. The row's `:bytes` reflects the STORED (stripped)
  size, so cap accounting (`live_bytes_sum/0`) matches the disk.
  Strip failures reject the upload with
  `{:error, {:metadata_strip, reason}}` — fail-closed, never
  stored-with-leak.

  `opts[:storage_root]` is the upload directory (typically
  `runtime/uploads`); tests inject a per-test temp path.
  `opts[:slug]` is injectable for deterministic tests; production
  callers omit it + take `mint_slug/0`.
  `opts[:now]` is injectable for time-sensitive tests.

  File-write failures bubble as `{:error, {:fs, posix_reason}}` —
  the row is NOT created.
  """
  @spec create(binary(), create_attrs(), create_opts()) ::
          {:ok, Upload.t()}
          | {:error, Ecto.Changeset.t()}
          | {:error, {:fs, File.posix()}}
          | MetadataStrip.error()
  def create(bytes, %{subject: subject, mime: mime} = attrs, opts) when is_binary(bytes) do
    storage_root = Keyword.fetch!(opts, :storage_root)
    slug = Keyword.get_lazy(opts, :slug, &mint_slug/0)
    path = storage_path(storage_root, slug)

    with {:ok, stored_bytes} <- MetadataStrip.run(bytes, mime),
         :ok <- File.mkdir_p(storage_root),
         :ok <- File.write(path, stored_bytes) do
      row_attrs =
        attrs
        |> Map.delete(:subject)
        |> Map.put(:slug, slug)
        |> Map.put(:bytes, byte_size(stored_bytes))
        |> Subject.put_subject_id(subject)

      insert_row(row_attrs, path)
    else
      {:error, {:metadata_strip, _}} = err ->
        err

      {:error, posix} when is_atom(posix) ->
        {:error, {:fs, posix}}
    end
  end

  defp insert_row(row_attrs, path) do
    case %Upload{} |> Upload.insert_changeset(row_attrs) |> Repo.insert() do
      {:ok, _} = ok ->
        ok

      {:error, %Ecto.Changeset{}} = err ->
        # Row insert failed AFTER the file landed on disk —
        # roll back the file write to avoid an orphan.
        _ = File.rm(path)
        err
    end
  rescue
    # Sqlite reports FK violation names as nil; Ecto's
    # `assoc_constraint` can't match and raises rather than
    # returning a changeset. Catch, rm the orphan file, and
    # re-shape as a generic constraint error the caller can
    # surface as 422 / 400 if it cares.
    e in Ecto.ConstraintError ->
      _ = File.rm(path)
      reraise e, __STACKTRACE__
  end

  @doc """
  Look up an upload by slug. Returns `:not_found` for any
  unresolvable state (bad slug shape, missing row, soft-deleted,
  expired). The single error variant collapses the four states so
  the public GET surface gives no information leakage.
  """
  @spec get_by_slug(String.t(), DateTime.t()) ::
          {:ok, Upload.t()} | {:error, :not_found}
  def get_by_slug(slug, %DateTime{} = now) do
    if valid_slug?(slug) do
      lookup_alive(slug, now)
    else
      {:error, :not_found}
    end
  end

  defp lookup_alive(slug, now) do
    case Repo.get_by(Upload, slug: slug) do
      nil -> {:error, :not_found}
      %Upload{deleted_at: %DateTime{}} -> {:error, :not_found}
      %Upload{expires_at: %DateTime{} = exp} = up -> if_unexpired(up, exp, now)
      %Upload{} = up -> {:ok, up}
    end
  end

  defp if_unexpired(up, exp, now) do
    case DateTime.compare(exp, now) do
      :gt -> {:ok, up}
      _ -> {:error, :not_found}
    end
  end

  @doc """
  Sum of `bytes` across all live (not-soft-deleted) rows. Used by
  the controller boundary to check the global-cap budget before
  accepting a new upload.
  """
  @spec live_bytes_sum() :: non_neg_integer()
  def live_bytes_sum do
    query = from u in Upload, where: is_nil(u.deleted_at), select: coalesce(sum(u.bytes), 0)
    Repo.one(query)
  end

  @doc """
  Live rows whose `expires_at` has passed. Reaper enumeration.
  """
  @spec list_expired(DateTime.t()) :: [Upload.t()]
  def list_expired(%DateTime{} = now) do
    query =
      from u in Upload,
        where: is_nil(u.deleted_at) and not is_nil(u.expires_at) and u.expires_at <= ^now,
        order_by: [asc: u.expires_at]

    Repo.all(query)
  end

  @doc """
  Admin enumeration — descending by insert time, INCLUDES soft-
  deleted rows (operator wants the full picture for disk-usage
  audit). Caller can filter `deleted_at` if needed.
  """
  @spec list_all() :: [Upload.t()]
  def list_all do
    query = from u in Upload, order_by: [desc: u.inserted_at]
    Repo.all(query)
  end

  @doc """
  Mark `upload` as soft-deleted at `now`. The caller MUST unlink
  the on-disk file BEFORE invoking this (Reaper does so in
  `sweep/0`; admin DELETE controller does so in
  `Admin.UploadsController.delete/2`). Idempotent: re-soft-delete
  of an already-deleted row is a no-op return.
  """
  @spec soft_delete(Upload.t(), DateTime.t()) ::
          {:ok, Upload.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def soft_delete(%Upload{deleted_at: %DateTime{}} = up, _), do: {:ok, up}

  def soft_delete(%Upload{} = up, %DateTime{} = now) do
    # #590 — `soft_delete/2` is shared by a BACKGROUND caller (the GC reaper)
    # and a WEB caller (admin DELETE). Ride out a transient SQLITE_BUSY on the
    # flip and degrade sustained saturation to `{:error, :db_unavailable}`
    # rather than letting the raise escape; each caller maps its terminal —
    # the reaper DROPS + logs (row left for the next tick, self-heals via the
    # enoent path), the admin controller routes to a 503 via FallbackController.
    Repo.BusyRetry.run(fn -> up |> Upload.soft_delete_changeset(now) |> Repo.update() end)
  end

  @doc """
  Fetch by id — used by the admin DELETE controller.
  """
  @spec get_by_id(Ecto.UUID.t()) :: {:ok, Upload.t()} | {:error, :not_found}
  def get_by_id(id) when is_binary(id) do
    case Repo.get(Upload, id) do
      nil -> {:error, :not_found}
      %Upload{} = up -> {:ok, up}
    end
  end

  @typedoc """
  The ceilings an upload write must clear, as
  `Grappa.ServerSettings.upload_caps/0` assembles them.

  `:user` and `:visitor` are SEPARATE ceilings (vjt's ruling, issue
  2175) — never one shared per-subject number. A visitor is disposable
  and reaped, so its ceiling is deliberately far under the user one.
  """
  @type caps :: %{global: pos_integer(), user: pos_integer(), visitor: pos_integer()}

  @doc """
  Admission check for the boundary: may `subject` add `incoming_bytes`
  to the store? `:ok` or `{:error, :insufficient_storage}`.

  TWO ceilings, both refused with the SAME error (vjt's ruling, issue
  2175): there is no self-service upload management yet — no listing,
  no delete — so the only actionable path out of a per-subject refusal
  is the same one the global cap already points at, the admin. A
  distinct error would name an affordance that does not exist. The day
  self-service lands this should be revisited.

  * **global** — the instance's whole disk budget, every subject's
    bytes. Unchanged behaviour; this used to be `check_global_cap/2`.
  * **per-subject** — the caller's OWN live bytes against the ceiling
    for their subject kind. `live_bytes_sum_for/1` counts only rows
    with `deleted_at IS NULL`, so the quota FREES ITSELF when the
    reaper collects an expired upload: no parallel accounting, no
    migration, no backfill. Anyone already over the ceiling is frozen
    out until their uploads expire.

  ## Why ONE function and not two siblings

  Every door that writes to the store must clear BOTH ceilings, and a
  door that called one helper and forgot the other would look wired.
  Issue 2175 shipped with three such doors and its own filing named
  only two, so this is measured rather than hypothetical. Folding the
  pair into a single call makes the half-wire unspellable: the next
  door (issue 2089 folds DCC into this pool) either checks or does not.
  """
  @spec check_caps(Subject.t(), non_neg_integer(), caps()) ::
          :ok | {:error, :insufficient_storage}
  def check_caps(subject, incoming_bytes, %{global: global_cap} = caps)
      when is_integer(incoming_bytes) and incoming_bytes >= 0 do
    with :ok <- within(live_bytes_sum(), incoming_bytes, global_cap) do
      within(live_bytes_sum_for(subject), incoming_bytes, subject_cap(caps, subject))
    end
  end

  # The one `case` the subject kind costs: the row already carries the
  # XOR FK, so the ceiling is picked off the subject rather than passed
  # in pre-resolved by each door.
  @spec subject_cap(caps(), Subject.t()) :: pos_integer()
  defp subject_cap(%{user: cap}, {:user, _}), do: cap
  defp subject_cap(%{visitor: cap}, {:visitor, _}), do: cap

  @spec within(non_neg_integer(), non_neg_integer(), pos_integer()) ::
          :ok | {:error, :insufficient_storage}
  defp within(live_bytes, incoming_bytes, cap) do
    if live_bytes + incoming_bytes > cap do
      {:error, :insufficient_storage}
    else
      :ok
    end
  end

  # `live_bytes_sum/0` narrowed to one subject — the same query plus a
  # `WHERE` on the FK the row already carries.
  @spec live_bytes_sum_for(Subject.t()) :: non_neg_integer()
  defp live_bytes_sum_for(subject) do
    Upload
    |> Subject.subject_where(subject)
    |> where([u], is_nil(u.deleted_at))
    |> select([u], coalesce(sum(u.bytes), 0))
    |> Repo.one()
  end

  @doc """
  HARD-delete every upload owned by `subject` — the on-disk bytes FIRST,
  the row after. Returns `:ok`; idempotent when the subject owns none.

  Called from the two chokepoints that every subject-destroying door
  funnels through — `Grappa.Accounts.delete_user/1` and
  `Grappa.Visitors.destroy_visitor/1` — because `uploads.user_id` /
  `uploads.visitor_id` carry `ON DELETE CASCADE`, which takes the ROWS
  and leaves the FILES (issue 1890). Routing it at the chokepoints and
  not at the self-delete door is deliberate: five doors reach those two
  functions, and the highest-cadence one is `Grappa.Visitors.Reaper`'s
  60-second sweep, not self-delete.

  ## Why the unlink cannot fail silently here

  `Grappa.Uploads.Reaper` can afford to leave a row alone when
  `File.rm/1` fails: the ROW IS ITS RETRY TOKEN, and the next sweep
  tries again. On this path the row is about to be destroyed, so no
  retry token will ever exist — a discarded error becomes a permanent
  leak that nothing can later detect, which is the silent-swallow
  CLAUDE.md forbids at a boundary. So the three outcomes stay apart:

    * `:ok` — unlinked.
    * `{:error, :enoent}` — NOT a failure, the expected idempotent case
      (the reaper or a prior partial run got there first). Logging it
      would drown the one line below that matters.
    * `{:error, reason}` — logged with the slug, and the deletion
      CONTINUES. A read-only disk must not hold someone's right to be
      deleted hostage; the log line is the only surrogate for the retry
      token being destroyed, and the slug is what makes the leaked
      bytes findable afterwards.
  """
  @spec delete_all_for_subject(Subject.t()) :: :ok
  def delete_all_for_subject(subject) do
    storage_root = storage_root()

    Upload
    |> Subject.subject_where(subject)
    |> Repo.all()
    |> Enum.each(&unlink_then_delete(&1, storage_root))

    :ok
  end

  @spec unlink_then_delete(Upload.t(), Path.t()) :: :ok
  defp unlink_then_delete(%Upload{slug: slug} = up, storage_root) do
    case File.rm(storage_path(storage_root, slug)) do
      :ok ->
        :ok

      {:error, :enoent} ->
        :ok

      {:error, reason} ->
        # Same metadata shape as `Grappa.Uploads.Reaper`'s failure line —
        # one greppable message, the identifiers as structured fields.
        Logger.error("upload orphaned: unlink failed, row deleted anyway",
          upload_id: up.id,
          slug: slug,
          error: inspect(reason)
        )
    end

    _ = Repo.delete!(up)
    :ok
  end
end
