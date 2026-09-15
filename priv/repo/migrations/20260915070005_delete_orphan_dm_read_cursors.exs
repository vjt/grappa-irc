defmodule Grappa.Repo.Migrations.DeleteOrphanDmReadCursors do
  @moduledoc """
  issue 2201 — drain the `read_cursors` rows a closed DM window left behind.

  `QueryWindows.close/4` deleted the `query_windows` row and nothing else,
  and no other path on the DM route ever removed the sibling cursor. The
  code fix (same commit) stops new orphans by deleting both rows in one
  transaction; this migration removes the ones already accrued.

  It is not only disk. `ReadCursor.bulk_for_subject/1` drives `FROM
  read_cursors`, so every orphan is a phantom entry in the `/me` envelope
  and in the unread machinery built on it, while the sidebar is built `FROM
  query_windows` — state the client cannot show and the operator therefore
  cannot clear.

  ## The count is RECOUNTED, never assumed

  The issue measured 273 orphans of 367 DM cursors over 65 subjects on
  2026-09-15, and the oldest row dated to May. That is a measurement of that
  moment: the set was still accruing when it was taken, and the code fix
  lands in the same commit, so the number here is whatever the predicate
  finds at run time. Nothing in this file depends on it.

  ## The predicate, and the two ways it could delete the wrong row

  A DM cursor is one whose key is NOT channel-shaped — the INVERSE sigil
  guard `20260729130000_collapse_nick_read_cursors` established. Two
  exclusions on top of it, both load-bearing:

    * **`$server` is not a DM.** The Grappa-internal pseudo-channel
      (`GrappaWeb.Validation.validate_target_name/1` admits it; the session
      writes server NOTICEs and MOTD there) is nick-shaped by this
      predicate and can NEVER have a `query_windows` row, because nobody
      opens a query with it. The sigil guard alone would therefore read
      every subject's server window as an orphan and delete its read
      position. Excluded by the `$` prefix rather than the literal name:
      `$` is outside the RFC 2812 nick charset, so no real DM key can start
      with it, and a future synthetic is covered by construction.
    * **The window match FOLDS.** `query_windows.target_nick` is stored
      case-preserving and matched case-insensitively (#121/#525), so a
      literal `=` would read `VJT` as "no window" for a cursor keyed `vjt`
      and delete a live read position. `lower()` on both sides is the same
      ASCII fold `Identifier.nick_fold/1` uses.

  The subject comparison is the `COALESCE(col,'')` XOR shape of the sibling
  read_cursors migration: a window belonging to a DIFFERENT subject must not
  rescue this subject's cursor.

  ## Accepted cost (ruling, 2026-09-15, «si cancella»)

  A DM window reopens by itself on a new message and comes back with no read
  position. No badge storm — with no cursor the unread machinery contributes
  nothing — but the "I had read up to here" bit is gone for the drained
  rows. A read position for a window the operator explicitly closed is not
  worth keeping.

  ## Idempotency + cold deploy

  The predicate is self-limiting: once an orphan is gone it cannot match
  again, so a re-run is a no-op. New migration — MUST be cold-deployed (the
  hot path skips `ecto.migrate`).
  """
  use Ecto.Migration

  # Nick-shaped keys only — the INVERSE of the channel fold migration's sigil
  # guard, plus the `$` synthetics, which are nick-shaped here but can never
  # own a query window. See the moduledoc: without the second clause this
  # deletes every subject's `$server` read position.
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
    # carried the only copy). Documented no-op, mirroring the read_cursors
    # collapse and the channel/visitor fold migrations' `down`.
    :ok
  end
end
