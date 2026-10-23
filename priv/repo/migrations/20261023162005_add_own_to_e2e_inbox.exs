defmodule Grappa.Repo.Migrations.AddOwnToE2eInbox do
  use Ecto.Migration

  # issue 2430 S1: when a device sends an encrypted message, the account's
  # OTHER devices get a copy through their inbox. `own` marks that copy.
  # Own rows share one sender bound (whatever nick we sent under) and
  # expire without telling anybody, so the two reads need the flag in the
  # row, not a guess from `sender`.
  def change do
    alter table(:e2e_inbox) do
      add :own, :boolean, null: false, default: false
    end
  end
end
