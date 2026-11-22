defmodule Grappa.Repo.Migrations.DeleteDmReadCursorsWithoutAWindow do
  @moduledoc """
  issue 2201, second drain — the DM read cursors written back AFTER their
  query window was closed.

  `20260915070005_delete_orphan_dm_read_cursors` drained the cursors a closed
  window left behind, and `QueryWindows.close/4` has deleted the cursor with
  the window ever since. That stopped ONE source. The other was the write
  door itself: `ReadCursor.set/4` checked that the message belonged to the
  key and nothing else, so any POST for a DM key the subject held no window
  for INSERTed a cursor no window shows. One writer that does it is known —
  cic's exit write when the operator closes the query they are reading,
  which fires off the `query_windows_list` broadcast the close emits AFTER
  its commit — but it is NOT what wrote the rows counted below (see there).
  The code fix (same branch) makes `set/4` refuse the write whoever sends
  it; this migration removes the rows already there.

  ## Why the SQL is a copy and not a call

  The body below is the first drain's predicate, VERBATIM — the `$` exclusion,
  the `COALESCE` subject XOR and the `lower()` fold on both sides, each of
  which deletes a live read position if dropped (the first drain's moduledoc
  says which and why). It is copied rather than shared because a migration is
  a frozen record of what ran: a helper both files call would let a later
  edit change what the 2026-09-15 migration "did" on every fresh database,
  while the databases that already ran it keep the old behaviour. The test
  (`delete_orphan_dm_read_cursors_test.exs`) runs the same cases against BOTH
  modules, so the two copies cannot drift apart unnoticed.

  ## The count is RECOUNTED, never assumed

  On 2026-11-22 a read-only count on production found 109 rows this predicate
  matches; 108 of them belong to one user across 7 networks and were written
  within one second on 2026-11-03, beside 42 channel cursors of the same
  burst — a client writing the cursor of every window it knew, not a close.
  That writer is not identified (the access logs of that day are rotated
  away). The count is a measurement of that moment, not a number this file
  depends on: the predicate deletes whatever it finds at run time.

  ## Idempotency + cold deploy

  Self-limiting — an orphan once deleted cannot match again, so a re-run is a
  no-op. New migration — MUST be cold-deployed (the hot path skips
  `ecto.migrate`).
  """
  use Ecto.Migration

  # VERBATIM from `20260915070005_delete_orphan_dm_read_cursors` — see the
  # moduledoc for why it is copied. Nick-shaped keys only, minus the `$`
  # synthetics, which are nick-shaped here but can never own a query window.
  @dm_predicate "substr(channel,1,1) NOT IN ('#','&','!','+') AND substr(channel,1,1) <> '$'"

  def up do
    execute("""
    DELETE FROM read_cursors
    WHERE #{@dm_predicate}
      AND NOT EXISTS (
        SELECT 1
        FROM query_windows q
        WHERE q.network_id = read_cursors.network_id
          AND COALESCE(q.user_id, '') = COALESCE(read_cursors.user_id, '')
          AND COALESCE(q.visitor_id, '') = COALESCE(read_cursors.visitor_id, '')
          AND lower(q.target_nick) = lower(read_cursors.channel)
      )
    """)
  end

  def down do
    # One-way cleanup: a deleted read position is unrecoverable (the row
    # carried the only copy). Documented no-op, like the first drain's `down`.
    :ok
  end
end
