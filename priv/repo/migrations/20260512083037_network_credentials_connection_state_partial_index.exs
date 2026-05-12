defmodule Grappa.Repo.Migrations.NetworkCredentialsConnectionStatePartialIndex do
  @moduledoc """
  CP24 cluster post-cr-review bucket B, persistence/S5 — partial index
  on `network_credentials.connection_state` for the Bootstrap hot path.

  `Grappa.Networks.Credentials.list_credentials_for_all_users/0` selects
  every row WHERE `connection_state = 'connected'` ORDER BY
  `(inserted_at, user_id, network_id)` at boot. Without an index the
  planner full-scans the table — fine while there are 5-50 rows but
  every row scan is back-pressure on the boot critical path.

  Mirrors the partial-index shape from
  `20260504015357_session_client_id_partial_index.exs`: only the
  `:connected` rows participate (parked + failed are intentionally
  skipped at the Bootstrap query level), so the index footprint stays
  tiny while the query plan becomes a direct lookup.
  """
  use Ecto.Migration

  def change do
    create index(:network_credentials, [:connection_state],
             where: "connection_state = 'connected'",
             name: :network_credentials_connection_state_connected_index
           )
  end
end
