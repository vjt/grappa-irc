defmodule Grappa.Repo.Migrations.CreateUserSettings do
  @moduledoc """
  Creates the `user_settings` table — a per-user JSON settings store for the
  channel-client-polish cluster.

  ## Purpose

  Many small per-user preferences (highlight watchlist, future UI toggles,
  notification thresholds) don't warrant individual columns or per-key rows.
  A single JSON column (`data`) per user row gives forward-compatibility: new
  preference keys land without migrations, and the entire settings object is
  fetched in one DB round-trip.

  First consumer: `highlight_patterns` — the cross-network mention watchlist
  used by the mentions-while-away window and in-scrollback highlight rendering
  (C7.7 / S3.5 scope).

  ## Why `:map` / JSON column over per-column or per-key tables

    * **Per-column**: every new setting requires an ALTER TABLE migration.
      With sqlite this often means a full table rebuild. Forward-compat cost
      is too high for a preference store.
    * **Per-key EAV table**: flexible but forces N joins or N queries per
      settings read. Also loses type information — every value is `TEXT`.
    * **JSON column (this choice)**: one row per user, one fetch, arbitrary
      nesting, no per-key migration overhead. New keys are application-level
      changes only. The trade-off is that the schema layer doesn't enforce
      key-level shapes — instead the context module (`Grappa.UserSettings`)
      provides typed accessor functions per known key.

  ## Schema design

    * `user_id` → `users.id` ON DELETE CASCADE — user deleted = their
      settings row gone automatically. Binary UUID FK (same shape as
      `query_windows.user_id`).
    * Unique index on `[:user_id]` — one row per user.
    * `data` — `:map` Ecto type. Ecto uses Jason to encode/decode; SQLite
      stores the JSON as TEXT and the sqlite json1 extension is available for
      future expression-indexed lookups.
    * `inserted_at` / `updated_at` — standard `:utc_datetime` timestamps.

  ## `:map` type behavior with ecto_sqlite3

  Ecto encodes `:map` fields via Jason before storage and decodes them on
  load. The implication is that atom-keyed maps written via a changeset are
  returned as string-keyed maps after a DB round-trip. Callers and tests
  MUST use string keys when reading `data` back from the DB. The
  `Grappa.UserSettings` context enforces this at every public accessor.

  ## Plain `create`

  CLAUDE.md: use plain `create` (not `create_if_not_exists`) so schema drift
  is a loud error, not a silent skip.
  """
  use Ecto.Migration

  def change do
    create table(:user_settings) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :data, :map, null: false, default: "{}"

      timestamps(type: :utc_datetime)
    end

    create unique_index(:user_settings, [:user_id])
  end
end
