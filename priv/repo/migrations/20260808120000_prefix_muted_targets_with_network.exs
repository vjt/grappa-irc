defmodule Grappa.Repo.Migrations.PrefixMutedTargetsWithNetwork do
  @moduledoc """
  #1038 — rewrite every stored BARE mute key into the composite
  `"<slug> <target>"` `ChannelKey`, once.

  ## Why a data migration is not optional here

  #866's mute key was the folded conversation and nothing else, and mutes
  are already stored in production under it (the batch at
  `0.14.0-ff0511cd` shipped the mute end to end). #1038 changes the key
  shape on both sides of the compare, so WITHOUT this pass every existing
  entry stops matching: the operator starts getting notified again from a
  room they silenced, while the settings list still shows it as muted. That
  is worse than a reset, because nothing on screen says anything changed.

  ## vjt's ruling (2026-08-08, #grappa): one-shot and optimistic

  Each bare key is prefixed with the FIRST network found in the DB for that
  subject — `ORDER BY network_credentials.id LIMIT 1`, i.e. the network they
  bound first. There is deliberately NO attempt to reconstruct which network
  the mute was really meant for; the information was never stored, so any
  reconstruction would be a guess dressed as a fact. A single-network
  subject (the common case) lands exactly right. A multi-network subject
  gets ONE plausible mute it can move by hand — visible in the settings
  list, which now names the network.

  It runs ONCE, here, at migration time. Expanding a bare key lazily on read
  (or on the next write) was considered and ruled out: a lazy path would
  have to keep existing forever, and it would silently re-create the
  network-blind behaviour for any client still emitting bare keys.

  ## What is deliberately NOT rewritten

    * **An already-composite key.** `instr(key, ' ') > 0` short-circuits it,
      which is also what makes the whole statement idempotent — a second run
      finds no bare key and the guard skips the row entirely.
    * **A subject with no credential at all.** There is nothing to prefix
      with. The bare key stays, matches nothing, and the conversation
      NOTIFIES. That is the correct direction: borrowing some other slug
      would silence a room the operator never muted. `Push.Triggers` fails
      open on an unmatchable key by construction (a composite can never
      equal a separator-less string), so no code change is needed to make
      that safe.
    * **Anything outside `muted_targets`.** `json_replace/3` on that one
      path leaves every sibling pref byte-identical.

  ## Subject polymorphism

  `user_settings` is XOR-FK'd (`user_id` / `visitor_id`), and so is
  `network_credentials`. The correlated lookup matches on WHICHEVER side is
  populated, with an explicit `IS NOT NULL` on each arm: a bare
  `nc.user_id = user_settings.user_id` compares NULL to NULL for a visitor
  row, which is NULL rather than true, and every visitor's mutes would have
  been skipped in silence.

  ## Guards, and the NULL that would have eaten the column

  The `WHERE` has three conjuncts and each one is load-bearing:

    1. `json_type(...) = 'object'` — no mute map, nothing to do. Also
       NULL-safe for a row whose `data` has no `notification_prefs`.
    2. an `EXISTS` for at least one bare key — this is what makes a re-run a
       no-op instead of a rewrite that happens to be identity.
    3. an `EXISTS` for at least one credential — WITHOUT it, the slug
       subquery returns NULL for a credential-less subject, `NULL || ' ' ||
       key` is NULL, and `json_group_object` raises on a NULL key. The guard
       turns "cannot be migrated" into "skipped", which is the honest
       outcome.

  ## Idempotent, and irreversible on purpose

  Re-running is a no-op (guard 2). `down/0` is not implemented as a rewrite:
  stripping the prefix back off cannot distinguish a key this migration
  wrote from one the operator has since created on a specific network, so a
  reverse pass would merge two deliberate mutes into one. A rollback of the
  #1038 code with the composite keys left standing degrades the same way an
  unmigrated key does under the new code — the mute stops matching and the
  conversation notifies — which is the safe direction.

  Cold or hot: `priv/repo/migrations/*` is classified COLD by Preflight, and
  since #41 the hot path migrates too, so this lands before the new key
  shape serves a request either way.
  """
  use Ecto.Migration

  def up do
    execute("""
    UPDATE user_settings
    SET data = json_replace(
      data,
      '$.notification_prefs.muted_targets',
      (SELECT json_group_object(
         CASE
           WHEN instr(entry.key, ' ') > 0 THEN entry.key
           ELSE (SELECT n.slug
                   FROM network_credentials nc
                   JOIN networks n ON n.id = nc.network_id
                  WHERE (user_settings.user_id IS NOT NULL AND nc.user_id = user_settings.user_id)
                     OR (user_settings.visitor_id IS NOT NULL AND nc.visitor_id = user_settings.visitor_id)
                  ORDER BY nc.id
                  LIMIT 1) || ' ' || entry.key
         END,
         json(entry.value))
       FROM json_each(json_extract(user_settings.data, '$.notification_prefs.muted_targets')) entry)
    )
    WHERE json_type(data, '$.notification_prefs.muted_targets') = 'object'
      AND EXISTS (
        SELECT 1
          FROM json_each(json_extract(user_settings.data, '$.notification_prefs.muted_targets')) bare
         WHERE instr(bare.key, ' ') = 0)
      AND EXISTS (
        SELECT 1
          FROM network_credentials nc2
         WHERE (user_settings.user_id IS NOT NULL AND nc2.user_id = user_settings.user_id)
            OR (user_settings.visitor_id IS NOT NULL AND nc2.visitor_id = user_settings.visitor_id))
    """)
  end

  def down do
    # Deliberately a no-op — see the moduledoc. Stripping the prefix cannot
    # tell a key this migration wrote from one an operator created on a
    # specific network afterwards, so the reverse pass would merge two
    # deliberate mutes into one.
    :ok
  end
end
