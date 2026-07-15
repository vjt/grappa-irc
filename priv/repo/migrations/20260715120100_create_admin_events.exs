defmodule Grappa.Repo.Migrations.CreateAdminEvents do
  @moduledoc """
  #215 Option B — disk-backing for the admin operator-events ring.

  The `Grappa.AdminEvents` singleton kept its ring in memory only, so a
  restart wiped the Events tab. This table durably mirrors the ring so the
  events survive a restart (Option B: keep the Events tab, make it
  disk-backed).

  `payload` is the full `Grappa.AdminEvents.Wire` event as JSON (`:map`) —
  the events are a HETEROGENEOUS union (~23 kinds with per-kind fields), so
  a JSON column beats 30+ mostly-null typed columns; the `kind` column is
  broken out for operator SQL filtering. Bounded by an on-insert prune in
  the sink (newest `retention` rows).

  ## Hot deploy

  New table only, but the feature (SessionLog sink child + Logger allowlist
  + AdminEvents behaviour change) is COLD as a whole.
  """
  use Ecto.Migration

  def change do
    create table(:admin_events) do
      add :kind, :string, null: false
      add :payload, :map, null: false
    end

    # Operator "show me all circuit_open events" — cheap, and the id PK
    # already covers the newest-first tail ordering.
    create index(:admin_events, [:kind])
  end
end
