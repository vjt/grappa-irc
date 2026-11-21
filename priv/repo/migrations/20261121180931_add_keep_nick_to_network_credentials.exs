defmodule Grappa.Repo.Migrations.AddKeepNickToNetworkCredentials do
  use Ecto.Migration

  # Issue 2656 — keepnick, opt-in per (subject, network). While on, a session
  # wearing a nick other than the configured one keeps asking for it back.
  # A column rather than session state because the switch must survive a
  # reconnect. `NOT NULL DEFAULT false`: every existing credential keeps
  # today's one-shot reclaim (#2253) until its owner turns the switch on, and
  # the default does the backfill — SQLite fills the new column in place.
  def change do
    alter table(:network_credentials) do
      add :keep_nick, :boolean, null: false, default: false
    end
  end
end
