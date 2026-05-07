defmodule Grappa.Repo.Migrations.AddDmWithToMessages do
  @moduledoc """
  CP14 B3 — adds the normalized "DM peer" column `:dm_with` on
  `messages` so DM (query) windows can fetch BOTH directions of the
  conversation in a single query, and so own-nick rotation
  (`grappa → vjt-grappa` after a NickServ ghost recovery) doesn't
  shard historical inbound DMs across past own-nicks.

  ## Bug being fixed

  IRC PRIVMSG framing persists outbound on `channel = peer_nick` and
  inbound on `channel = own_nick`. Cic's `loadInitialScrollback(peer)`
  only fetches `?channel=peer`, so the query window for a peer shows
  only what the operator typed — never the peer's replies. Compounded
  by own-nick rotation, where past inbound DMs are partitioned across
  whatever own-nick was active at the time.

  ## Schema change

  * Add `dm_with :text NULL` to `messages`.
  * Index `(network_id, dm_with, server_time)` so the
    `or_where(dm_with: ^peer)` branch in `Scrollback.fetch/5` is an
    index scan, identical shape to the existing
    `(network_id, channel, server_time)` index.

  ## Backfill

  Inline at migrate-time. Pre-approved 2026-05-07 vjt brainstorm:
  prod has ~300 candidate rows; sub-100ms sweep. Fallback option
  (write-time-only, no backfill) was held in reserve if the backfill
  proved complex.

  Heuristic: for every PRIVMSG row, derive `own_nick` from the
  CURRENT credential (user) or visitor's `:nick`. Rows where
  `channel == own_nick` (case-insensitive) get `dm_with = sender`;
  rows where `sender == own_nick` AND target is nick-shaped get
  `dm_with = channel`. Rows from a past own-nick (e.g. inbound
  persisted under `channel = "grappa"` BEFORE rotation to
  `vjt-grappa`) stay with `dm_with = NULL` — accepted trade-off per
  the brainstorm: the write-time path is the canonical fix; backfill
  is best-effort recovery for historical rows.

  Down-migration drops index then column.
  """
  use Ecto.Migration
  import Ecto.Query

  def up do
    alter table(:messages) do
      add :dm_with, :text, null: true
    end

    flush()

    create index(:messages, [:network_id, :dm_with, :server_time])

    flush()

    backfill_dm_with()
  end

  def down do
    drop_if_exists index(:messages, [:network_id, :dm_with, :server_time])

    alter table(:messages) do
      remove :dm_with
    end
  end

  # ---------------------------------------------------------------------------
  # Backfill helpers — local, schema-free Ecto.Query so this migration is
  # immune to future renames/drops of the high-level schema modules.
  # ---------------------------------------------------------------------------

  defp backfill_dm_with do
    user_pairs =
      repo().all(
        from c in "network_credentials",
          where: not is_nil(c.nick),
          select: {c.user_id, c.network_id, c.nick}
      )

    visitor_pairs =
      repo().all(
        from v in "visitors",
          inner_join: n in "networks",
          on: n.slug == v.network_slug,
          where: not is_nil(v.nick),
          select: {v.id, n.id, v.nick}
      )

    Enum.each(user_pairs, fn {user_id, network_id, own_nick} ->
      backfill_subject(:user_id, user_id, network_id, own_nick)
    end)

    Enum.each(visitor_pairs, fn {visitor_id, network_id, own_nick} ->
      backfill_subject(:visitor_id, visitor_id, network_id, own_nick)
    end)
  end

  defp backfill_subject(subject_field, subject_id, network_id, own_nick) do
    own_nick_lower = String.downcase(own_nick)

    # Inbound DMs: channel == own_nick (case-insensitive); dm_with = sender.
    from(m in "messages",
      where: field(m, ^subject_field) == ^subject_id,
      where: m.network_id == ^network_id,
      where: m.kind == "privmsg",
      where: fragment("lower(?) = ?", m.channel, ^own_nick_lower),
      where: is_nil(m.dm_with),
      update: [set: [dm_with: m.sender]]
    )
    |> repo().update_all([])

    # Outbound DMs: sender == own_nick (case-insensitive) AND target is NOT
    # a channel sigil ('#', '&', '!', '+') and not the synthetic '$server'.
    # dm_with = channel (the peer's nick).
    from(m in "messages",
      where: field(m, ^subject_field) == ^subject_id,
      where: m.network_id == ^network_id,
      where: m.kind == "privmsg",
      where: fragment("lower(?) = ?", m.sender, ^own_nick_lower),
      where:
        fragment(
          "substr(?, 1, 1) NOT IN ('#', '&', '!', '+', '$')",
          m.channel
        ),
      where: is_nil(m.dm_with),
      update: [set: [dm_with: m.channel]]
    )
    |> repo().update_all([])
  end
end
