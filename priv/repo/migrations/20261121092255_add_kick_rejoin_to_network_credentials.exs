defmodule Grappa.Repo.Migrations.AddKickRejoinToNetworkCredentials do
  use Ecto.Migration

  # Issue 2657 — the opt-in rejoin after a self-KICK, per (subject, network)
  # binding. OFF by default, so every existing row keeps the #2044 behaviour
  # (a kick means leave); the delay defaults to 10 s, ZNC's `kickrejoin`
  # default, and stays in the row while the opt-in is off. Both columns
  # carry a default, so an old-code INSERT that names neither stays valid.
  # The closed set of delays (0, 10, 30, 60) is enforced by
  # `Grappa.Networks.Credential.kick_rejoin_changeset/2`, not here.
  def change do
    alter table(:network_credentials) do
      add :kick_rejoin, :boolean, null: false, default: false
      add :kick_rejoin_delay_seconds, :integer, null: false, default: 10
    end
  end
end
