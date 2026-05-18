defmodule Grappa.Repo.Migrations.BackfillLowercaseChannels do
  @moduledoc """
  UX-4 bucket A — backfill every channel-shape column in the schema to
  RFC-2812-§2.2 canonical lowercase. Going forward, the IRC parser
  wrapper at `Grappa.Session.EventRouter.route/2` canonicalises every
  channel param before clause dispatch; the schema changesets
  (`Grappa.Scrollback.Message`, `Grappa.ReadCursor.Cursor`,
  `Grappa.Networks.Credential`, `Grappa.Visitors.VisitorChannel`)
  pin the same rule defense-in-depth at the persist boundary; the
  `Grappa.PubSub.Topic.channel/3` builder canonicalises the topic
  segment; cic's `canonicalChannel(name)` mirrors all of this client-
  side. This one-shot migration brings historical rows into line.

  ## Columns touched

    * `messages.channel`                      — scrollback rows
    * `read_cursors.channel`                  — per-window read cursors
    * `network_credentials.autojoin_channels` — JSON array per credential
    * `network_credentials.last_joined_channels` — JSON array per credential
    * `visitor_channels.name`                 — visitor JOIN snapshot

  ## NOT touched

    * `messages.dm_with`   — peer NICK, display-case meaningful
    * `messages.sender`    — sender NICK, display-case meaningful
    * `query_windows.target_nick` — peer NICK
    * `users.name`, `visitors.nick`, network slugs — not IRC channels
    * `$server` synthetic pseudo-channel rows — already lowercase
      sentinel (NOT a real channel name; `target_kind/1` classifies
      it `:query`)

  ## Sigil predicate

  Only rows whose `channel` starts with one of the four IRC chanstring
  sigils (`#`, `&`, `!`, `+`) are lowercased. Anything else is a nick
  (DM peer), `$server`, or some legacy synthetic key that bucket A
  intentionally leaves alone. Matches `Identifier.canonical_channel/1`
  (sigil-aware) on the Elixir side + `canonicalChannel(name)` on the
  cic side.

  ## Idempotency

  Every statement uses `WHERE channel != lower(channel) AND
  substr(channel,1,1) IN ('#','&','!','+')` (or the JSON-array analog).
  Re-running the migration is a no-op once rows are canonical. sqlite
  `lower()` is ASCII-only — sufficient for IRC channel names per
  RFC 2812 §2.2 (which itself only specifies ASCII case-folding;
  Unicode folding deferred to a future RFC).

  ## JSON-array columns

  `autojoin_channels` + `last_joined_channels` + `visitor_channels.name`
  (per row) are persisted via Ecto's `{:array, :string}` shape which
  uses sqlite JSON. The simplest reliable backfill on a JSON-array
  column in sqlite is to UPDATE each row's column with
  `json_group_array(lower(value))` materialised via a CTE — but
  Bahamut-shape sqlite ships `json1` extension, so we use json_each +
  json_group_array directly.

  For `visitor_channels.name` the column is plain TEXT (one row per
  channel, not a JSON array), so the simple lowercase form applies.

  ## Cold deploy

  Per `feedback_cluster_with_migration_must_cold` — `scripts/deploy.sh`
  hot path skips `mix ecto.migrate`; a new migration MUST be cold-
  deployed so the UPDATE runs before any session boot reads stale
  case-mixed rows.
  """
  use Ecto.Migration

  # All four RFC 2812 chanstring sigils. Inlined so the migration text
  # is self-contained (no module dep — migrations run in a possibly-
  # truncated code load order during release upgrades).
  @sigil_predicate "substr(channel,1,1) IN ('#','&','!','+')"

  def up do
    # Scrollback rows. `messages` has only non-unique indexes on the
    # `(user, network, channel)` triple, so collapsing case variants
    # via UPDATE is safe — no constraint violation when `#Chan` and
    # `#chan` end up with the same key.
    execute("""
    UPDATE messages
    SET channel = lower(channel)
    WHERE channel != lower(channel)
      AND #{@sigil_predicate}
    """)

    # Read cursors. `read_cursors` has a partial UNIQUE index on
    # `(user_id, network_id, channel)` (one per subject branch) — a
    # naive UPDATE collapsing `#Chan` and `#chan` into `#chan` would
    # violate the constraint when BOTH variants already exist for the
    # same subject+network. Resolve by deleting all-but-the-highest-
    # `last_read_message_id` row per case-variant collision before the
    # UPDATE folds the survivors. "Highest" wins because the cursor
    # semantics are monotonic — the operator's latest READ position
    # is the meaningful one; older rows are stale.
    #
    # Selection uses MAX(last_read_message_id) — NOT MAX(id) — because
    # `id` is autoincrement insertion order and can diverge from the
    # read-position semantic on rows that were `update_at`-touched
    # after a later cursor row was inserted for a different case
    # variant (rare in practice but reviewer-flagged). Tie-break by
    # `id DESC` keeps the case-variant the operator typed most
    # recently when two rows happen to share the same
    # `last_read_message_id`.
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
            AND lower(r2.channel) = lower(r1.channel)
            AND substr(r2.channel,1,1) IN ('#','&','!','+')
          ORDER BY r2.last_read_message_id DESC, r2.id DESC
          LIMIT 1
        )
    )
    AND #{@sigil_predicate}
    """)

    execute("""
    UPDATE read_cursors
    SET channel = lower(channel)
    WHERE channel != lower(channel)
      AND #{@sigil_predicate}
    """)

    # Visitor JOIN snapshot. `visitor_channels` has UNIQUE on
    # `(visitor_id, network_slug, name)` — same dedup pattern as
    # read_cursors. Column is `name`, predicate adjusted accordingly.
    # No `last_read_message_id` equivalent; pick the highest `id`
    # arbitrarily — both rows represent the same logical autojoin
    # entry, the keep-criterion is irrelevant.
    execute("""
    DELETE FROM visitor_channels
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM visitor_channels
      WHERE substr(name,1,1) IN ('#','&','!','+')
      GROUP BY visitor_id, network_slug, lower(name)
    )
    AND substr(name,1,1) IN ('#','&','!','+')
    """)

    execute("""
    UPDATE visitor_channels
    SET name = lower(name)
    WHERE name != lower(name)
      AND substr(name,1,1) IN ('#','&','!','+')
    """)

    # JSON-array columns on network_credentials. sqlite json1 idiom:
    # rebuild the array element-by-element via `json_group_array(...)`
    # over a `json_each(...)` decomposition, lowercasing channel-shape
    # entries (defensive: an operator-typed list may contain
    # mistakenly-uppercased channels). Non-channel-shape entries
    # (defensive — `validate_autojoin_channels/2` shouldn't allow them
    # but the migration is contract-tolerant) pass through unchanged.
    # No constraint to worry about: the array column is plain JSON
    # TEXT; duplicate-element-after-lowercase doesn't violate anything
    # at the DB layer (the `validate_autojoin_channels/2` changeset
    # validates per-element shape, not uniqueness, so the post-
    # migration list may legitimately contain dup entries until the
    # next changeset write dedups them — Session.Server's
    # `Enum.uniq/1` on the boot-merge of autojoin + last_joined
    # handles dup-tolerance at consumer time).
    #
    # The CASE preserves nicks etc.; the SET only fires when any
    # element would actually change, so re-running is a no-op.
    execute("""
    UPDATE network_credentials
    SET autojoin_channels = (
      SELECT json_group_array(
               CASE
                 WHEN substr(value, 1, 1) IN ('#', '&', '!', '+')
                   THEN lower(value)
                 ELSE value
               END
             )
      FROM json_each(network_credentials.autojoin_channels)
    )
    WHERE EXISTS (
      SELECT 1
      FROM json_each(network_credentials.autojoin_channels)
      WHERE substr(value, 1, 1) IN ('#', '&', '!', '+')
        AND value != lower(value)
    )
    """)

    execute("""
    UPDATE network_credentials
    SET last_joined_channels = (
      SELECT json_group_array(
               CASE
                 WHEN substr(value, 1, 1) IN ('#', '&', '!', '+')
                   THEN lower(value)
                 ELSE value
               END
             )
      FROM json_each(network_credentials.last_joined_channels)
    )
    WHERE EXISTS (
      SELECT 1
      FROM json_each(network_credentials.last_joined_channels)
      WHERE substr(value, 1, 1) IN ('#', '&', '!', '+')
        AND value != lower(value)
    )
    """)
  end

  def down do
    # The backfill is a one-way correction. There is no source of
    # truth for the original mixed-case spelling — running `down`
    # would not restore it. Documented no-op rather than a misleading
    # "rollback" that does nothing.
    :ok
  end
end
