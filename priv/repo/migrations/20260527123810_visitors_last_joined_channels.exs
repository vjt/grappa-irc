defmodule Grappa.Repo.Migrations.VisitorsLastJoinedChannels do
  @moduledoc """
  Visitor rejoin-on-restart parity with users.

  Mirror of `20260510170000_add_last_joined_channels_to_network_credentials`
  for the visitor schema. Adds `visitors.last_joined_channels` (JSON
  array of channel names, same shape as `network_credentials.last_joined_channels`)
  and drops the now-redundant `visitor_channels` table that was declared
  but never written to — the schema comment in
  `Grappa.Visitors.VisitorChannel` admitted the writer never landed,
  with the consequence that bouncer restarts re-spawned visitor
  sessions but never rejoined any channel.

  Single shape for both subject classes: `Session.Server`'s
  `persist_last_joined/4` writes the same JSON array column for users
  and visitors. The `visitor_channels` table was the original design
  (one-row-per-channel) but the user side settled on a JSON column
  and consistency wins.

  Drop is safe: the `visitor_channels` table has been empty since it
  was created in `20260502080806_create_visitor_channels` because no
  writer ever existed in `lib/` — the producer cluster was always
  deferred to "the visitor-rejoin-on-restart cluster" (this one). No
  data backfill needed; existing visitor rows boot with
  `last_joined_channels = []` and rebuild the snapshot on the first
  self-JOIN / self-PART / self-KICK after deploy.
  """
  use Ecto.Migration

  def change do
    alter table(:visitors) do
      add :last_joined_channels, :text, null: false, default: "[]"
    end

    drop table(:visitor_channels)
  end
end
