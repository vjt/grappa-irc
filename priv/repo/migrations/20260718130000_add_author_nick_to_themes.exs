defmodule Grappa.Repo.Migrations.AddAuthorNickToThemes do
  use Ecto.Migration

  # #299 amendment (author model A) — a NULLABLE snapshot of the publishing
  # visitor's representative nick, persisted at PUBLISH time so attribution
  # survives the visitor's reap + system re-home.
  # `rehome_visitor_published_to_system/1` flips a reaped visitor's PUBLISHED
  # theme to the `system` owner (visitor_id → nil); without a stored snapshot
  # the wire author would collapse to "system"/"guest". The snapshot is the
  # single source the wire prefers whenever present, regardless of current
  # owner.
  #
  # Expand-safe: add-column only — no drop, no rename, no blocking backfill —
  # so it rides the already-HELD #299 COLD batch. Legacy rows keep NULL: the
  # wire falls back to the user's name (user themes) or the fixed "guest"
  # label (pre-amendment visitor themes), so no data change for existing rows.
  def change do
    alter table(:themes) do
      add :author_nick, :string
    end
  end
end
