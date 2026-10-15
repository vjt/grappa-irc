defmodule Grappa.Repo.Migrations.AddMessagesAwayWindowIndex do
  @moduledoc """
  issue 2419 — the index `Grappa.Mentions.aggregate_mentions/6` seeks: a
  user's CONTENT rows on one network, in `server_time` order.

  ## Why PARTIAL on `kind`, and not the plain `(user_id, network_id, server_time)`

  The plain shape was built and declined under issue 2240 (DESIGN_NOTES
  2026-09-19, #2240b) because it took the DM reads' plans away from the
  #393 folded-COALESCE index. It still does, at a different site: measured
  with that index present, `Scrollback.fetch_by_time/7` on a DM window
  (issue 2372, which landed after #2240b) plans
  `SEARCH … (user_id=? AND network_id=? AND server_time<?)` and walks the
  whole account in time order filtering for the peer, where it used to
  seek the conversation.

  The `kind IN (…)` term is what keeps every other read off this index.
  SQLite uses a partial index only for a query whose WHERE carries the
  index's predicate term, and the only query that writes
  `kind IN ('privmsg','notice','action')` as literal SQL is the away
  bundle's. Measured on a sqlite3 bench (DESIGN_NOTES, issue 2419): with
  this index present, twelve DM and channel read shapes keep their plans,
  and a bound `kind IN (?,?,?)` — what `where: m.kind in ^list` emits —
  does not use it either. So the
  query has to spell the list literally; `Grappa.Mentions` builds that
  literal from `Message.content_kinds/0`.

  `user_id IS NOT NULL` keeps visitor rows out (the away bundle runs for
  user sessions only), the same gate `messages_archive_user_idx` uses.

  ## The IN list is FROZEN here

  It is `Message.content_kinds/0` as of this migration. A migration is
  history, so it does not read the live list. If a content kind is ever
  added, the query's literal moves and this predicate does not, so the
  index silently stops matching. `Grappa.MentionsTest` compares the
  stored predicate against the query's literal and goes red. The fix is
  then a new migration that rebuilds the index.

  ## Deploy class

  HOT: a bare `create index` in `change/0` is an expand op for
  `Grappa.Deploy.Preflight.classify_migration/1`, and this file is on
  `PreflightTest`'s pinned HOT list.

  ⚠️ The build holds the write lock for as long as it scans `messages`, on
  the live pool of a hot deploy, and a writer does not wait that long: past
  the `BusyRetry` budget a scrollback row is degraded to
  `:persist_unavailable` and not stored. Measured on the host: 2.0-2.1 s
  for 1.2M rows, which puts prod's ~5.2M near 10 s; not measured on prod.
  The rows arriving during that window, less its last ~1.5 s, are lost.
  DESIGN_NOTES (issue 2419) has the numbers and the cold-deploy
  alternative.
  """
  use Ecto.Migration

  def change do
    create index(
             :messages,
             [:user_id, :network_id, :server_time],
             name: :messages_away_window_user_idx,
             where: "user_id IS NOT NULL AND kind IN ('privmsg','notice','action')"
           )
  end
end
