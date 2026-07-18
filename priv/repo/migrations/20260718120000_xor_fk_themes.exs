defmodule Grappa.Repo.Migrations.XorFkThemes do
  @moduledoc """
  #299 item 8 — promote `themes` to the subject-XOR FK shape so a theme
  can belong to EITHER a user OR a visitor. Visitors become first-class
  theme producers (copy / edit / publish / keep).

  ## Why a table-recreate (not ALTER)

  `themes.owner_id` is `TEXT NOT NULL REFERENCES users`. A visitor theme
  carries `user_id IS NULL` (its subject is `visitor_id`), and SQLite can
  neither change a column's nullability nor `ALTER TABLE ADD CONSTRAINT`
  (the XOR CHECK). So this is the same table-recreate dance the other XOR
  tables use — `20260515005117_xor_fk_user_settings.exs` is the closest
  template (a `:map` column + timestamps):

    * RENAME `owner_id` → `user_id` and make it nullable,
    * ADD `visitor_id TEXT NULL REFERENCES visitors(id) ON DELETE CASCADE`,
    * ADD `CONSTRAINT themes_subject_xor CHECK
      ((user_id IS NULL) <> (visitor_id IS NULL))`,
    * replace the single `(owner_id, name)` unique with TWO partial
      uniques: `(user_id, name) WHERE user_id IS NOT NULL` and
      `(visitor_id, name) WHERE visitor_id IS NOT NULL`.

  ## `id` MUST be preserved (pointer target — unlike network_credentials)

  The surrogate `themes.id` is NOT invisible: it is a POINTER TARGET.
  `user_settings.data["active_theme_id"]` stores a theme id (the
  per-subject active-theme pointer, #75), and share-links reference a
  theme by id. So — unlike the `network_credentials` recreate, which
  minted fresh AUTOINCREMENT ids — this INSERT carries `id` verbatim
  (`SELECT id, ...`) so every active-theme pointer and share-link keeps
  resolving. (Same as the `user_settings` recreate, which also carried
  `id` for the settings row identity.)

  ## Column carry-forward (frozen snapshot)

  The full column set from the original create (`20260717120000`):
  `name`, `payload`, `published`, `apply_count`, `inserted_at`,
  `updated_at` — plus the renamed subject FK. A future recreate copying
  this pattern MUST bring forward every column added since.

  ## Nothing FK-references themes

  Grepped: zero `references(:themes)` in the schema — the active-theme
  pointer is a plain JSON value, not a DB FK. So the recreate is
  self-contained (no dependent-table FK refresh). `PRAGMA
  defer_foreign_keys=ON` still guards the rows' OWN FK refs (users /
  visitors) during the rename+drop.

  ## Cold deploy

  New migration — the hot deploy path skips `ecto.migrate`. MUST ride the
  COLD window (#299) or the first query against the reshaped table 500s.
  """
  use Ecto.Migration

  def up do
    execute("PRAGMA defer_foreign_keys=ON")

    execute("ALTER TABLE themes RENAME TO themes_old")

    execute("""
    CREATE TABLE "themes" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "themes_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "themes_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "name" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "published" BOOLEAN NOT NULL DEFAULT 0,
      "apply_count" INTEGER NOT NULL DEFAULT 0,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "themes_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    # Every existing theme (incl. the system-owned built-ins) is user-owned
    # → visitor_id NULL. `id` is carried VERBATIM: it is a pointer target
    # (user_settings.data.active_theme_id + share-links), not an invisible
    # surrogate.
    execute("""
    INSERT INTO themes (id, user_id, visitor_id, name, payload, published, apply_count, inserted_at, updated_at)
    SELECT id, owner_id, NULL, name, payload, published, apply_count, inserted_at, updated_at
    FROM themes_old
    """)

    execute("DROP TABLE themes_old")

    # Partial unique indexes — one per subject branch. WHERE ... IS NOT
    # NULL keeps NULL pairs out so a user row and a visitor row never
    # collide on the index. The user index name matches the changeset's
    # `unique_constraint([:user_id, :name], name: :themes_user_id_name_index)`.
    create unique_index(:themes, [:user_id, :name],
             name: :themes_user_id_name_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:themes, [:visitor_id, :name],
             name: :themes_visitor_id_name_index,
             where: "visitor_id IS NOT NULL"
           )

    # Non-unique lookup indexes (per-subject listing hot paths + gallery).
    create index(:themes, [:user_id])
    create index(:themes, [:visitor_id])
    create index(:themes, [:published], where: "published = 1")
  end

  def down do
    execute("PRAGMA defer_foreign_keys=ON")

    # Reverse to the user-only, NOT NULL owner shape. Visitor themes
    # (user_id IS NULL) cannot survive a NOT NULL user_id column, so the
    # WHERE drops them — the documented one-way risk of rolling back an
    # expand (the visitor rows themselves are untouched; their private
    # themes are discarded, published ones were already re-homed to the
    # system user at reap time and survive as user-owned).
    execute("ALTER TABLE themes RENAME TO themes_new")

    execute("""
    CREATE TABLE "themes" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "owner_id" TEXT NOT NULL CONSTRAINT "themes_owner_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "name" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "published" BOOLEAN NOT NULL DEFAULT 0,
      "apply_count" INTEGER NOT NULL DEFAULT 0,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO themes (id, owner_id, name, payload, published, apply_count, inserted_at, updated_at)
    SELECT id, user_id, name, payload, published, apply_count, inserted_at, updated_at
    FROM themes_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE themes_new")

    create index(:themes, [:owner_id])
    create index(:themes, [:published], where: "published = 1")
    create unique_index(:themes, [:owner_id, :name])
  end
end
