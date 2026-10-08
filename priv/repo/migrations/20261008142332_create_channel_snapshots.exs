defmodule Grappa.Repo.Migrations.CreateChannelSnapshots do
  use Ecto.Migration

  # issue 2348 — a channel-membership snapshot per 366 RPL_ENDOFNAMES, for
  # the archive-based presence stats that cannot be rebuilt from deltas
  # alone (every session gap loses the QUITs that happened during it).
  # Append-only, one row per 366 (vjt's Q1 ruling, "all").
  #
  # A table of its own and never `messages`: a snapshot is not a line in a
  # conversation, it has no renderer, and it is never sent over the wire.
  #
  # The subject XOR is a COLUMN-level CHECK inside `create table`, not the
  # raw `execute` of `create_dcc_files`: `Grappa.Deploy.Preflight` classifies
  # any `execute` COLD, and ecto_sqlite3 raises on `create constraint`. SQLite
  # accepts a column CHECK that reads another column of the row, so the
  # constraint is the same one `messages` and `dcc_files` carry, and the
  # migration stays a plain `create table` — HOT.
  def change do
    create table(:channel_snapshots) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: true

      add :visitor_id, references(:visitors, type: :binary_id, on_delete: :delete_all),
        null: true,
        check: %{
          name: "channel_snapshots_subject_xor",
          expr: "(user_id IS NULL) <> (visitor_id IS NULL)"
        }

      add :network_id, references(:networks, on_delete: :delete_all), null: false
      # Folded, like every channel-keyed table: the 366's channel param is
      # normalised at ingress, so the row stores the members-map key.
      add :channel, :string, null: false
      # Epoch milliseconds, sampled locally — the unit of
      # `messages.server_time`, so a reader can interleave the two.
      add :ts, :integer, null: false
      # Raw (display) nicks, JSON-encoded: the snapshot is written and read
      # whole, never queried by nick.
      add :nicks, {:array, :string}, null: false
    end

    create index(:channel_snapshots, [:user_id, :network_id, :channel, :ts])
    create index(:channel_snapshots, [:visitor_id, :network_id, :channel, :ts])
  end
end
