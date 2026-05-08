defmodule Grappa.Repo.Migrations.MessagesDmWithSubjectCompositeIndexes do
  @moduledoc """
  Codebase review 2026-05-08 H1 — replace the subject-less
  `(network_id, dm_with, server_time)` index with two subject-leading
  composites that mirror the channel-side shape already in place
  (`(user_id, network_id, channel, server_time)` from
  `20260426000003_messages_per_user_iso.exs` and
  `(visitor_id, network_id, channel, server_time)` from
  `20260504020001_messages_visitor_composite_index.exs`).

  ## Bug being fixed

  CP14 B3 created `(network_id, dm_with, server_time)` for the OR arm
  of `Scrollback.fetch/5`'s `channel_or_dm_where/2`:

      where(query, [m], m.channel == ^channel or m.dm_with == ^channel)

  SQLite picks ONE index per OR arm. The dm_with arm scanned every row
  on `(network_id, dm_with)` matching the peer **across every
  user/visitor on that network**, then post-filtered by
  `subject_where/2` (`user_id = ?` or `visitor_id = ?`). Two
  consequences:

    1. Perf asymmetry vs the channel arm — N× index pages walked for a
       peer DM'd by N users on the same network. Worst on busy peers
       (service bots), the cheapest case to optimize.
    2. Per-subject iso friction — boundary still HOLDS (the
       `subject_where` filter is in the WHERE clause), but the index
       does cross-subject work BEFORE iso. On prod where `messages` is
       the largest table by an order of magnitude, this turns a single-
       index-scan plan into index-scan + row-fetch + subject-filter.

  ## Fix

  Two composites with the same leading-key shape as the channel-side
  indexes:

    * `(user_id, network_id, dm_with, server_time)`
    * `(visitor_id, network_id, dm_with, server_time)`

  Drop the subject-less index. SQLite picks the right composite per
  arm based on the `subject_where/2` filter that's already on the
  query. `EXPLAIN QUERY PLAN` for `Scrollback.fetch({:user, ...}, ...,
  peer, nil, 100)` should show both arms of the OR resolved via index
  scans on the new composites.

  Migration is additive on data shape — index-only change. No row
  rewrites; instant on dev, ~ms on prod-sized data.
  """
  use Ecto.Migration

  def change do
    drop index(:messages, [:network_id, :dm_with, :server_time])

    create index(:messages, [:user_id, :network_id, :dm_with, :server_time])
    create index(:messages, [:visitor_id, :network_id, :dm_with, :server_time])
  end
end
