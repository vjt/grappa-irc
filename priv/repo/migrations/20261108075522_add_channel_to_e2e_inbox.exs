defmodule Grappa.Repo.Migrations.AddChannelToE2eInbox do
  use Ecto.Migration

  # Channel E2E (Megolm-style group sessions, protocol v63): one
  # encrypted message, sent once as a PRIVMSG to the channel, is queued
  # into every listed device's inbox like a `to: *` DM — and the device
  # must know WHICH channel it came from, so the row carries it. NULL
  # means a direct message, as before; a channel row holds the folded
  # channel name exactly as the frame's target arrived.
  #
  # Appended after `payload` (which the original table keeps last on
  # purpose, so the cap check and the expiry sweep never walk its
  # overflow pages): `channel` is only read when the whole row is
  # fetched for delivery, payload included, so its position costs
  # nothing.
  def change do
    alter table(:e2e_inbox) do
      add :channel, :string
    end
  end
end
