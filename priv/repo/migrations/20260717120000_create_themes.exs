defmodule Grappa.Repo.Migrations.CreateThemes do
  @moduledoc """
  #75 — the themes catalog. Every theme is an INDEPENDENT FULL COPY (KISS,
  vjt): no copy-on-write, no shared storage, no reference/usage counter that
  gates lifecycle, no delete-in-use guard. Deleting a copy can never affect
  anyone else because everyone already has their own copy.

    * `owner_id` — the author. Built-in themes are owned by the seeded "system"
      user (read-only for everyone but admins; no non-admin can be its owner ⇒
      read-only falls out of the authz check, no `built_in` column needed —
      it's derived from `owner_id == system_user.id`).
    * `payload` — the sanitized canonical token map (see
      `Grappa.Themes.TokenModel`). Only closed-vocabulary tokens ever land here.
    * `published` — gallery-list inclusion. All themes are readable by id
      (share-link target); `published` only controls the browse list.
    * `apply_count` — a MONOTONIC analytics counter (how many times this gallery
      entry was copied). It is NOT a refcount: it never decrements, gates
      nothing, and copies store no back-reference to the source. Consistent with
      the "no reference counter" rule (that rule bans lifecycle refcounts).

  `on_delete: :delete_all` on the owner FK: deleting a user removes their own
  themes; independent copies other users hold are untouched.
  """
  use Ecto.Migration

  def change do
    create table(:themes) do
      add :name, :string, null: false
      add :owner_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :payload, :map, null: false
      add :published, :boolean, null: false, default: false
      add :apply_count, :integer, null: false, default: 0
      timestamps(type: :utc_datetime_usec)
    end

    create index(:themes, [:owner_id])
    create index(:themes, [:published], where: "published = 1")
    create unique_index(:themes, [:owner_id, :name])
  end
end
