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

    * `create/3` — accepts `{file_bytes, attrs, opts}`, writes to
      disk, inserts row. `attrs` carries the subject (XOR
      user/visitor FK), `mime`, optional `original_filename`,
      optional `expires_at`. `opts` carries `:storage_root` (DI for
      tests) + the random-slug + clock injection seams.
    * `get_by_slug/1` — slug → `{:ok, %Upload{}} | {:error, :not_found}`.
      Respects soft-delete + expiry: an expired or soft-deleted row
      reads as `:not_found` so the public GET surface has no oracle.
    * `live_bytes_sum/0` — `SUM(bytes) WHERE deleted_at IS NULL`
      for global-cap pre-check.
    * `list_expired/0` — Reaper enumeration: rows with
      `expires_at <= now()` AND `deleted_at IS NULL`.
    * `soft_delete/2` — flips `deleted_at`. The caller MUST `File.rm/1`
      the on-disk file FIRST (Reaper does this in `sweep/0`).
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

  Deps: `Grappa.Repo`, `Grappa.Subject`. NOT `Grappa.ServerSettings`
  (caps are passed in by the controller — Uploads context is pure
  persistence + filesystem; cap policy lives at the boundary).
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo, Grappa.Subject], exports: [Upload]

  import Ecto.Query

  alias Grappa.{Repo, Subject}
  alias Grappa.Uploads.Upload

  @slug_byte_size 16
  @slug_regex ~r/\A[a-z2-7]{26}\z/

  @storage_root_key {__MODULE__, :storage_root}

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

  @type create_attrs :: %{
          required(:subject) => Subject.t(),
          required(:mime) => String.t(),
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
  Write `bytes` to disk + insert a row. Returns the inserted row or
  an error.

  `opts[:storage_root]` is the upload directory (typically
  `runtime/uploads`); tests inject a per-test temp path.
  `opts[:slug]` is injectable for deterministic tests; production
  callers omit it + take `mint_slug/0`.
  `opts[:now]` is injectable for time-sensitive tests.

  File-write failures bubble as `{:error, {:fs, posix_reason}}` —
  the row is NOT created.
  """
  @spec create(binary(), create_attrs(), create_opts()) ::
          {:ok, Upload.t()} | {:error, Ecto.Changeset.t()} | {:error, {:fs, File.posix()}}
  def create(bytes, %{subject: subject} = attrs, opts) when is_binary(bytes) do
    storage_root = Keyword.fetch!(opts, :storage_root)
    slug = Keyword.get_lazy(opts, :slug, &mint_slug/0)

    row_attrs =
      attrs
      |> Map.delete(:subject)
      |> Map.put(:slug, slug)
      |> Map.put(:bytes, byte_size(bytes))
      |> Subject.put_subject_id(subject)

    path = storage_path(storage_root, slug)

    with :ok <- File.mkdir_p(storage_root),
         :ok <- File.write(path, bytes) do
      try do
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
    else
      {:error, posix} when is_atom(posix) ->
        {:error, {:fs, posix}}
    end
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
  @spec soft_delete(Upload.t(), DateTime.t()) :: {:ok, Upload.t()} | {:error, Ecto.Changeset.t()}
  def soft_delete(%Upload{deleted_at: %DateTime{}} = up, _), do: {:ok, up}

  def soft_delete(%Upload{} = up, %DateTime{} = now) do
    up |> Upload.soft_delete_changeset(now) |> Repo.update()
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

  @doc """
  Helper for the controller boundary — checks whether accepting
  `incoming_bytes` would exceed `global_cap_bytes`. Returns
  `:ok` or `{:error, :insufficient_storage}`.
  """
  @spec check_global_cap(non_neg_integer(), pos_integer()) ::
          :ok | {:error, :insufficient_storage}
  def check_global_cap(incoming_bytes, global_cap_bytes)
      when is_integer(incoming_bytes) and is_integer(global_cap_bytes) do
    if live_bytes_sum() + incoming_bytes > global_cap_bytes do
      {:error, :insufficient_storage}
    else
      :ok
    end
  end
end
