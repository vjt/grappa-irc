defmodule Grappa.Repo.Migrations.CreateUploadsAndServerSettings do
  @moduledoc """
  UX-6 bucket B1 (2026-05-20) — embedded image uploader.

  Two tables ship together:

  ## `uploads`

  One row per image uploaded via `POST /api/uploads`. Slug is the
  URL path component AND the on-disk filename under
  `runtime/uploads/<slug>`. 16 random bytes base32-encoded (26 chars
  no padding) — 128 bits of entropy. Slug uniqueness is the access
  token: anyone with the URL gets the bytes via the unauthenticated
  `GET /uploads/:slug`. Same model as litterbox.

  Subject FK is XOR (`user_id` XOR `visitor_id`), matching
  `Grappa.Scrollback.Message` + `Grappa.UserSettings.Settings` +
  `Grappa.ReadCursor.Cursor`. Visitor reaping CASCADEs uploads
  (their bytes go with them).

  `deleted_at` is the soft-delete marker — the Reaper unlinks the
  file BEFORE marking the row to avoid the GET-races-Reaper window
  (a GET arriving between the file-unlink and the soft-delete sees
  the row live + ENOENT on disk, which it handles as 404). Soft-
  delete preserves the row for telemetry + global-cap accounting
  hygiene.

  The CHECK constraint for the XOR subject FK is declared INLINE
  in the raw `CREATE TABLE` rather than via the Ecto DSL — sqlite
  doesn't support `ALTER TABLE ADD CONSTRAINT`, mirroring the
  push_subscriptions XOR migration (V1.b, 2026-05-15).

  ## `server_settings`

  K/v table for admin-managed server-wide configuration. Same shape
  as `Grappa.UserSettings.data` (JSON `:map`-in-text) but one row
  per setting key rather than one row per subject. Lets new admin
  settings land without per-setting migrations.

  ## Indices

  - `unique(slug)` — primary lookup key, URL parsing.
  - `(expires_at) where deleted_at IS NULL AND expires_at IS NOT NULL`
    — Reaper sweep. Partial index keeps the index small at scale.
  - `(deleted_at) where deleted_at IS NULL` — global-cap-sum query.
  - `unique(key)` on `server_settings` — k/v key uniqueness.

  ## Cold-deploy required

  New tables → COLD deploy per `feedback_cluster_with_migration_must
  _cold`. Hot path skips `mix ecto.migrate`; first query post-
  reload would 500.
  """
  use Ecto.Migration

  def up do
    execute("""
    CREATE TABLE "uploads" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "uploads_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "uploads_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "mime" TEXT NOT NULL,
      "bytes" INTEGER NOT NULL,
      "original_filename" TEXT NULL,
      "expires_at" TEXT NULL,
      "deleted_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "uploads_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    create unique_index(:uploads, [:slug])

    # Reaper sweep — only rows with non-null expires_at AND not yet
    # soft-deleted are candidates. Partial index keeps it cheap.
    create index(:uploads, [:expires_at],
             where: "deleted_at IS NULL AND expires_at IS NOT NULL",
             name: :uploads_expires_at_active_idx
           )

    # Global-cap-sum query — `SUM(bytes) WHERE deleted_at IS NULL`.
    # Partial index narrows scans to the live set even when soft-
    # deleted rows accumulate.
    create index(:uploads, [:deleted_at],
             where: "deleted_at IS NULL",
             name: :uploads_live_idx
           )

    create table(:server_settings, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :key, :string, null: false
      add :value, :text, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:server_settings, [:key])
  end

  def down do
    drop table(:server_settings)
    drop table(:uploads)
  end
end
