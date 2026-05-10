defmodule Grappa.Repo.Migrations.AddLastJoinedChannelsToNetworkCredentials do
  @moduledoc """
  CP22 cluster B (channel-client-polish #14, B-restart sub-bucket) —
  rejoin-on-restart fix.

  Adds `last_joined_channels :: [string]` to `network_credentials`. The
  Session.Server writes the live `Map.keys(state.members)` snapshot to
  this column on every self-JOIN / self-PART / self-KICK so a graceful
  or crash restart can rehydrate the channel list at boot.

  Boot semantics: union of `autojoin_channels` (operator config —
  channels you ALWAYS want auto-joined) + `last_joined_channels`
  (runtime snapshot — channels you were in last time the session was
  alive). Dedupe at the boot site.

  Default `[]` matches existing rows' implied state. Pre-existing
  bindings rejoin only their `autojoin_channels` until the session
  goes through one self-JOIN/PART/KICK cycle and writes the snapshot.

  ## sqlite array-type representation

  `{:array, :string}` round-trips through ecto_sqlite3 as a JSON
  TEXT column under the hood — same shape as the existing
  `autojoin_channels` field, no special handling needed at the
  migration level.
  """
  use Ecto.Migration

  def change do
    alter table(:network_credentials) do
      add :last_joined_channels, :text, null: false, default: "[]"
    end
  end
end
