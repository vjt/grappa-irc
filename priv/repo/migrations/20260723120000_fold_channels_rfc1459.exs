defmodule Grappa.Repo.Migrations.FoldChannelsRfc1459 do
  @moduledoc """
  GH #364 (E/irc-S4) — bring every stored channel column onto bahamut's
  `CASEMAPPING=rfc1459`, the SAME fold nicks use (#121). This is the
  channel twin of the `20260518120000_backfill_lowercase_channels`
  one-shot: same structure, but the fold ALSO maps the four rfc1459
  "national" chars `[ ] \\ ~` -> `{ } | ^`, not just ASCII case.

  ## Why now (reverses UX-4-A downcase)

  UX-4-A folded channels with Unicode `String.downcase/1`. Historical
  rows are therefore already ASCII-lowercased but NOT bracket-folded, so
  `#chan[1]` and `#chan{1}` — one channel to the ircd — sit in two
  windows / scrollback streams / cursors. `Identifier.canonical_channel/1`
  now folds rfc1459 at every write boundary; this migration converges
  the historical rows so the going-forward key and the stored key agree.

  ## Scope: brackets only, going forward

  The fold below LOWERS + bracket-maps. Since UX-4-A already lowered the
  data, the `channel != fold(channel)` / `EXISTS` guards fire ONLY for
  rows that contain one of `[ ] \\ ~` — a tiny, bounded set. Non-ASCII
  case variants (`#CAFÉ` vs `#café`) that UX-4-A's Unicode downcase
  MERGED are NOT un-merged here: the original mixed case is unrecoverable
  and #364's "stop merging non-ASCII" is a going-forward code change
  (the ASCII-only `canonical_channel/1`), not a historical rewrite.

  `dm_with` / `sender` (nicks, display-case) and nick-shaped inbound-DM
  `channel = own_nick` rows are untouched — the `substr(...,1,1) IN
  ('#','&','!','+')` sigil guard restricts every statement to real
  channels. Nick folding is #121's job.

  ## Columns touched

    * `messages.channel`                          — non-unique, safe UPDATE
    * `read_cursors.channel`                       — UNIQUE per subject: collapse then UPDATE
    * `network_featured_channels.name`             — UNIQUE per network: collapse then UPDATE
    * `network_credentials.autojoin_channels`      — JSON array
    * `network_credentials.last_joined_channels`   — JSON array

  `channel_directory.name` is deliberately NOT folded — directory rows
  are stored VERBATIM (case-preserving display, like nicks); the
  featured-label compare folds at read time in `ChannelDirectory.Wire`.

  ## Fold expression (single source)

  `fold/1` is byte-identical to the query_windows / notify / visitor fold
  migrations and to `Grappa.IRC.Identifier.nick_fold_sql/1`; the
  `IdentifierTest` fold-drift pin fails if any copy drifts (SQLite is
  ASCII-only in `lower()`, matching the byte-level Elixir fold).

  ## Idempotency + cold deploy

  Every statement guards on `channel != fold(channel)` (or the JSON
  `EXISTS`/`GROUP BY` analog), so a re-run is a no-op once rows are
  canonical. New migration — MUST be cold-deployed (the hot path skips
  `ecto.migrate`), so the UPDATE runs before any session boot reads
  stale bracket-cased rows.
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, pure SQL. Self-contained (no
  # module dep — migrations may run before the app is loaded). Byte-for-
  # byte identical to the other fold migrations + `Identifier.nick_fold_sql/1`.
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  # All four RFC 2812 chanstring sigils — restricts each statement to
  # real channels, leaving DM nick-channels + nicks to the #121 fold.
  @sigil_predicate "substr(channel,1,1) IN ('#','&','!','+')"

  def up do
    # Scrollback rows. `messages` has only non-unique indexes on the
    # `(user, network, channel)` triple, so folding case variants via
    # UPDATE is safe — no constraint violation when `#chan[1]` and
    # `#chan{1}` collapse onto one key.
    execute("""
    UPDATE messages
    SET channel = #{fold("channel")}
    WHERE channel != #{fold("channel")}
      AND #{@sigil_predicate}
    """)

    # Read cursors. `read_cursors` has a partial UNIQUE index on
    # `(subject, network_id, channel)` — folding `#chan[1]` and `#chan{1}`
    # onto one key would violate it when BOTH variants exist for the same
    # subject+network. Collapse first, keeping the row with the highest
    # `last_read_message_id` (the operator's latest read position is the
    # meaningful one; older case-variant rows are stale). Tie-break by
    # `id DESC` — same rule the lowercase backfill used.
    execute("""
    DELETE FROM read_cursors
    WHERE rowid NOT IN (
      SELECT rowid
      FROM read_cursors r1
      WHERE #{@sigil_predicate}
        AND id = (
          SELECT id
          FROM read_cursors r2
          WHERE r2.network_id = r1.network_id
            AND COALESCE(r2.user_id, '') = COALESCE(r1.user_id, '')
            AND COALESCE(r2.visitor_id, '') = COALESCE(r1.visitor_id, '')
            AND #{fold("r2.channel")} = #{fold("r1.channel")}
            AND substr(r2.channel,1,1) IN ('#','&','!','+')
          ORDER BY r2.last_read_message_id DESC, r2.id DESC
          LIMIT 1
        )
    )
    AND #{@sigil_predicate}
    """)

    execute("""
    UPDATE read_cursors
    SET channel = #{fold("channel")}
    WHERE channel != #{fold("channel")}
      AND #{@sigil_predicate}
    """)

    # Featured channels. `network_featured_channels` has a UNIQUE index on
    # `(network_id, name)`; fold-collisions per network must collapse
    # before the UPDATE. Keep `MAX(id)` — both rows are the same featured
    # channel; the most-recently-added row's label/enabled flag wins.
    execute("""
    DELETE FROM network_featured_channels
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM network_featured_channels
      WHERE substr(name,1,1) IN ('#','&','!','+')
      GROUP BY network_id, #{fold("name")}
    )
    AND substr(name,1,1) IN ('#','&','!','+')
    """)

    execute("""
    UPDATE network_featured_channels
    SET name = #{fold("name")}
    WHERE name != #{fold("name")}
      AND substr(name,1,1) IN ('#','&','!','+')
    """)

    # JSON-array columns on network_credentials. Rebuild each array
    # element-by-element via `json_group_array(...)` over `json_each(...)`,
    # folding channel-shape entries; non-channel entries pass through. No
    # DB constraint on the array; the `Enum.uniq`/`canonical_channel`
    # dedup at consumer time (SessionPlan.merge_autojoin, Session.Server
    # boot) collapses any duplicate-after-fold. The SET only fires when an
    # element would actually change, so re-running is a no-op.
    execute("""
    UPDATE network_credentials
    SET autojoin_channels = (
      SELECT json_group_array(
               CASE
                 WHEN substr(value, 1, 1) IN ('#', '&', '!', '+')
                   THEN #{fold("value")}
                 ELSE value
               END
             )
      FROM json_each(network_credentials.autojoin_channels)
    )
    WHERE EXISTS (
      SELECT 1
      FROM json_each(network_credentials.autojoin_channels)
      WHERE substr(value, 1, 1) IN ('#', '&', '!', '+')
        AND value != #{fold("value")}
    )
    """)

    execute("""
    UPDATE network_credentials
    SET last_joined_channels = (
      SELECT json_group_array(
               CASE
                 WHEN substr(value, 1, 1) IN ('#', '&', '!', '+')
                   THEN #{fold("value")}
                 ELSE value
               END
             )
      FROM json_each(network_credentials.last_joined_channels)
    )
    WHERE EXISTS (
      SELECT 1
      FROM json_each(network_credentials.last_joined_channels)
      WHERE substr(value, 1, 1) IN ('#', '&', '!', '+')
        AND value != #{fold("value")}
    )
    """)
  end

  def down do
    # One-way correction: there is no source of truth for the original
    # bracket-cased spelling, so `down` cannot restore it. Documented
    # no-op rather than a misleading rollback (mirrors the lowercase
    # backfill's `down`).
    :ok
  end
end
