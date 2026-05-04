defmodule Grappa.Repo.Migrations.AddConnectionStateToNetworkCredentials do
  @moduledoc """
  T32 — adds `connection_state` enum + `_reason` + `_changed_at`
  columns to `network_credentials`. Powers the `/disconnect` (park),
  `/connect` (unpark), `/quit` (nuclear park-all) verbs from the
  channel-client-polish cluster.

  Default `:connected` matches existing rows' implied state.
  Backfill is the column default — every pre-T32 credential row
  represents an actively-bound network whose Bootstrap-spawned
  Session.Server is the proof. Operator-driven state changes go
  through `Grappa.Networks.connect/disconnect/mark_failed`.

  Runtime sub-states (`:connecting`, `:reconnecting`, `:backing_off`)
  stay in `Session.Server` GenServer state — NOT mirrored to DB.
  Only the user-visible terminal/intent states land here.
  """
  use Ecto.Migration

  def change do
    alter table(:network_credentials) do
      add :connection_state, :string, null: false, default: "connected"
      add :connection_state_reason, :string, null: true

      add :connection_state_changed_at, :utc_datetime,
        null: false,
        default: fragment("CURRENT_TIMESTAMP")
    end
  end
end
