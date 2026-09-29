defmodule Grappa.Repo.Migrations.BackfillDmConversations do
  @moduledoc """
  issue 1365 leg 1 — mint one `dm_conversations` row per existing DM
  conversation and point every existing DM row at it.

  ## The correctness criterion

  A conversation is attached to EXACTLY the rows today's grouping puts under
  one DM key: `lower(COALESCE(dm_with, channel))`, per `(subject, network)`,
  over the rows `Scrollback.dm_eligible?/1` admits — the key is not
  `$server` and its first byte is not a channel sigil (`# & ! +`). That is
  the key `Scrollback.where_dm_peer/2` reads a DM window by, the key
  `list_archive/3` groups on, and the key the #396 unread counts join on.
  No merge, no split.

  🔴 **"No sigil" is NOT a DM proxy.** `$server` is 98.5% of the unsigilled
  rows on prod (224,121 of 227,502, orchestrator's census 2026-09-28): the
  predicate below carries the explicit `$server` carve-out
  `dm_eligible?/1` carries, not a `$` prefix and not a bare sigil test.

  ## Deliberate deviation from the 2026-09-28 backfill plan

  That plan left the untagged CURRENT-own-nick rows (`channel = own`,
  `dm_with IS NULL`) with a NULL FK, to reproduce the self-window READ
  narrowing of `channel_or_dm_where/3`. This migration attaches them to the
  own-nick conversation instead, for two reasons:

    * The readers do not agree on that class. The #396 unread counts
      (`ReadCursor.bulk_unread_split/3`) and `list_archive/3` group it under
      the own-nick key; only the scrollback fetch narrows it away. A static
      FK can reproduce one reader, and the plain key is the one three of
      them already use.
    * "Current own nick" is not a property of a row: it moves on every
      `/nick`, and the reader's narrowing moves with it. Keying the FK on it
      would bake one moment's nick into the schema. The narrowing stays what
      it is — a READ filter — and remains expressible on top of the FK.

  Nothing reads the FK in leg 1, so attaching makes nothing visible.

  ## Sources, in the order they mint (first spelling wins)

    1. `query_windows` — the open window's spelling, and its open state.
    2. `messages` — the most recent raw `COALESCE(dm_with, channel)` by id.
    3. `read_cursors` on a DM key — expected to add nothing
       (`20260915070005` drained the windowless DM cursors), minted anyway
       so every DM cursor has a parent to point at.

  Then open state is MIRRORED from `query_windows` (open iff a window
  exists), and the children are attached.

  ## Batched, and idempotent

  `@disable_ddl_transaction`: each statement commits on its own. The message
  attach runs per conversation in batches of 1,000 rows — a crash leaves a
  committed prefix, never a child pointing at a missing parent (every parent
  is minted before any child is touched). Minting is `ON CONFLICT DO
  NOTHING`, attaching is `WHERE dm_conversation_id IS NULL`, the open-state
  mirror is a pure function of `query_windows`: a second run is a no-op.

  ## Not measured

  The mint scan reads every `messages` row once. **Its duration at prod scale
  is NOT measured**; neither is the attach. The numbers above are counts,
  not timings.
  """
  use Ecto.Migration

  @disable_ddl_transaction true

  @batch 1_000

  # `Scrollback.dm_eligible?/1`, in SQL, over a key expression.
  defp dm_eligible(key),
    do: "(#{key} <> '$server' AND substr(#{key}, 1, 1) NOT IN ('#', '&', '!', '+'))"

  @msg_key "COALESCE(dm_with, channel)"

  @now "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

  def up do
    mint_from_windows()
    mint_from_messages()
    mint_from_cursors()
    mirror_open_state()
    attach_messages()
    attach_cursors()
  end

  def down do
    execute("UPDATE read_cursors SET dm_conversation_id = NULL WHERE dm_conversation_id IS NOT NULL")
    execute("UPDATE messages SET dm_conversation_id = NULL WHERE dm_conversation_id IS NOT NULL")
    execute("DELETE FROM dm_conversations")
  end

  defp mint_from_windows do
    execute("""
    INSERT INTO dm_conversations
      (user_id, visitor_id, network_id, peer_nick, opened_at, inserted_at, updated_at)
    SELECT user_id, visitor_id, network_id, target_nick, opened_at, #{@now}, #{@now}
    FROM query_windows
    WHERE true
    ON CONFLICT DO NOTHING
    """)
  end

  # SQLite takes a bare column in an aggregate query from the row that
  # produced `max(id)`, so `peer_nick` is the latest spelling of the key.
  defp mint_from_messages do
    execute("""
    INSERT INTO dm_conversations
      (user_id, visitor_id, network_id, peer_nick, opened_at, inserted_at, updated_at)
    SELECT user_id, visitor_id, network_id, peer_nick, NULL, #{@now}, #{@now}
    FROM (
      SELECT user_id, visitor_id, network_id, #{@msg_key} AS peer_nick, max(id)
      FROM messages
      WHERE #{dm_eligible(@msg_key)}
      GROUP BY user_id, visitor_id, network_id, lower(#{@msg_key})
    )
    WHERE true
    ON CONFLICT DO NOTHING
    """)
  end

  defp mint_from_cursors do
    execute("""
    INSERT INTO dm_conversations
      (user_id, visitor_id, network_id, peer_nick, opened_at, inserted_at, updated_at)
    SELECT user_id, visitor_id, network_id, channel, NULL, #{@now}, #{@now}
    FROM read_cursors
    WHERE #{dm_eligible("channel")}
    ON CONFLICT DO NOTHING
    """)
  end

  # `IS` is SQLite's NULL-safe equality: the subject match must hold on both
  # XOR columns, or another subject's window would open this conversation.
  defp mirror_open_state do
    execute("""
    UPDATE dm_conversations
    SET opened_at = (
      SELECT q.opened_at
      FROM query_windows q
      WHERE q.user_id IS dm_conversations.user_id
        AND q.visitor_id IS dm_conversations.visitor_id
        AND q.network_id = dm_conversations.network_id
        AND lower(q.target_nick) = lower(dm_conversations.peer_nick)
    )
    """)
  end

  defp attach_messages do
    flush()

    %{rows: conversations} =
      repo().query!("SELECT id, user_id, visitor_id, network_id, lower(peer_nick) FROM dm_conversations")

    Enum.each(conversations, &attach_conversation/1)
  end

  # Seeks the subject-leading `…_dm_coalesce_fold_…` covering index: the
  # subject column is named, not matched with `IS`, so the planner can use it.
  defp attach_conversation([id, user_id, nil, network_id, key]),
    do: attach_batches(id, "user_id", user_id, network_id, key)

  defp attach_conversation([id, nil, visitor_id, network_id, key]),
    do: attach_batches(id, "visitor_id", visitor_id, network_id, key)

  defp attach_batches(id, subject_col, subject_id, network_id, key) do
    %{num_rows: moved} =
      repo().query!(
        """
        UPDATE messages SET dm_conversation_id = ?1
        WHERE id IN (
          SELECT id FROM messages
          WHERE #{subject_col} = ?2
            AND network_id = ?3
            AND lower(#{@msg_key}) = ?4
            AND dm_conversation_id IS NULL
          LIMIT #{@batch}
        )
        """,
        [id, subject_id, network_id, key]
      )

    if moved == @batch, do: attach_batches(id, subject_col, subject_id, network_id, key)
  end

  defp attach_cursors do
    execute("""
    UPDATE read_cursors
    SET dm_conversation_id = (
      SELECT c.id
      FROM dm_conversations c
      WHERE c.user_id IS read_cursors.user_id
        AND c.visitor_id IS read_cursors.visitor_id
        AND c.network_id = read_cursors.network_id
        AND lower(c.peer_nick) = lower(read_cursors.channel)
    )
    WHERE dm_conversation_id IS NULL AND #{dm_eligible("channel")}
    """)
  end
end
