defmodule Grappa.Repo.Migrations.AddMessagesIdCursorCompositeIndexes do
  @moduledoc """
  Add the id-cursor composite indexes on `messages` + the missing
  `uploads.visitor_id` cascade-FK index (#379, P0 — periodic multi-core
  CPU spike).

  ## Root cause — CP29 R-2 index regression

  CP29 R-2 switched the scrollback since-cursor key from `server_time`
  to monotonic `id` (same-ms ties straddling a page boundary could
  lose/duplicate rows). Every incremental read path now filters
  `id > cursor ORDER BY id`:

    * `Scrollback.fetch_after/6`
    * `Scrollback.count_after/5`
    * `Scrollback.count_after_split/5`
    * `Scrollback.unread_content_tail/6`

  But every `messages` composite still ENDS in `server_time`
  (`(<subject>, network_id, channel|dm_with, server_time)` — kept
  because `fetch/6` still orders `server_time DESC`). So `id > ?` was
  NOT index-eligible: SQLite fell back to the single-column
  `messages_network_id_index` and scanned all of the busiest network's
  post-cursor rows, filtering `channel` / subject row by row (prod
  EXPLAIN: `SEARCH messages USING INDEX messages_network_id_index
  (network_id=? AND rowid>?)` over ~570k rows). These reads fire on
  every channel join + unread-count, ×~18 topics per WebSocket
  reconnect, so it was a near-constant SQLite dirty-scheduler burn —
  the "periodic multi-core CPU spike" the operator reported (dirty-IO
  threads dominating cumulative CPU, hidden from `:recon` which
  excludes dirty schedulers).

  ## Fix

  Add the id-twin of each existing `…server_time` composite. KEEP the
  `server_time` twins (the `fetch/6` `server_time DESC` display path
  still needs them). Verified on a copy of the prod DB — the channel
  since-cursor path flips from the full network scan to:

      SEARCH USING INDEX messages_visitor_id_network_id_channel_id_index
        (visitor_id=? AND network_id=? AND channel=? AND id>?)   -- clean seek, no sort
      -- count_after/5 is COVERING on the same index (no table touch)

  The DM-peer OR view (`channel=? OR dm_with=?`) still filesorts even
  with these (a residual OR-across-two-indexes cost, tracked as a
  separate follow-up); the `dm_with` id-twins are added for symmetry so
  the `dm_with=?` arm and the own-nick self-msg path are index-seekable
  rather than scanned.

  ## `uploads.visitor_id`

  `uploads` is an `ON DELETE CASCADE` child of `visitors` that shipped
  WITHOUT an index on `visitor_id`
  (`20260520215304_create_uploads_and_server_settings.exs`), so every
  visitor delete full-scans `uploads` to enforce the FK (`EXPLAIN →
  SCAN uploads`). The index turns that into a seek.

  Plain `create` (drift should fail loudly per CLAUDE.md); reversible
  via `up`/`down`. Deploy class: **COLD** — a new
  `priv/repo/migrations/*` file is Class 5 in `Grappa.Deploy.Preflight`
  (the hot path skips `mix ecto.migrate`, so `--force-hot` past this
  would silently NOT build the indexes and the CPU burn would persist).
  The `CREATE INDEX` DDL is itself online-safe for the running old code
  (expand-class — no schema-shape change), but the four `messages`
  builds share one migration transaction, so the write lock is held
  across their cumulative ~4-pass scan of the ~570k-row table — schedule
  off a traffic peak. See DESIGN_NOTES 2026-07-22.
  """
  use Ecto.Migration

  def up do
    # Channel since-cursor paths (fetch_after/count_after/…): the
    # id-twins of the `(…, channel, server_time)` composites.
    create index(:messages, [:visitor_id, :network_id, :channel, :id])
    create index(:messages, [:user_id, :network_id, :channel, :id])

    # DM since-cursor paths: id-twins of the `(…, dm_with, server_time)`
    # composites.
    create index(:messages, [:visitor_id, :network_id, :dm_with, :id])
    create index(:messages, [:user_id, :network_id, :dm_with, :id])

    # Cascade-FK child-key index — the one genuinely-missing index #379
    # called out (unindexed ON DELETE CASCADE child of `visitors`).
    create index(:uploads, [:visitor_id])
  end

  def down do
    drop index(:uploads, [:visitor_id])

    drop index(:messages, [:user_id, :network_id, :dm_with, :id])
    drop index(:messages, [:visitor_id, :network_id, :dm_with, :id])
    drop index(:messages, [:user_id, :network_id, :channel, :id])
    drop index(:messages, [:visitor_id, :network_id, :channel, :id])
  end
end
