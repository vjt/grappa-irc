defmodule Grappa.Repo.Migrations.CreateE2eRequests do
  use Ecto.Migration

  # issue 2486: asking a peer to start an encrypted chat, and the peer's
  # answer, kept server-side so the exchange completes even when the two
  # clients are never online together (vjt's ruling, design B). One row
  # per (subject, network, peer), whichever side asked: the crossing rules
  # in `Grappa.E2eRequests` never leave an incoming and an outgoing request
  # towards the same nick, so one row is enough.
  #
  # `peer` is RAW (display and wire); the folded expression index below is
  # the KEY, like `query_windows.target_nick`. `state` is the stored closed
  # set; `expired` is derived from `updated_at` at read time, never stored.
  # `updated_at` is when the row entered its state: for a pending row the
  # instant the REQUEST went out or arrived, which the 24 h deadline counts
  # from. `payload` is the peer's latest, opaque (grappa never parses it).
  # `peer_device` is the `from` of the peer's latest consent line on the row
  # (a device id, or `*` when their grappa answered for them), where grappa
  # sends a REFUSE the user gives without a device of its own (vjt's ruling
  # R2); NULL until a line of theirs stands. Never on the wire.
  #
  # Raw SQL for the table body, like the other e2e tables: the subject XOR
  # and the state set are CHECK constraints. `AUTOINCREMENT` because a
  # client dismisses by id, and an id handed out again could make a stale
  # dismiss or `e2e_request_gone` hit a newer request.

  # The ASCII fold of `peer`, written out so the #525 fold pin in
  # `Grappa.IRC.IdentifierTest` can compare it against
  # `Identifier.nick_fold_sql("peer")`: one byte of drift reddens there.
  @folded_peer "lower(peer)"

  def up do
    execute("""
    CREATE TABLE "e2e_requests" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "e2e_requests_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "e2e_requests_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "e2e_requests_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "peer" TEXT NOT NULL,
      "state" TEXT NOT NULL,
      "payload" TEXT NULL,
      "peer_device" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "e2e_requests_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "e2e_requests_state" CHECK (state IN ('incoming', 'outgoing', 'accepted', 'refused'))
    )
    """)

    # One row per folded peer in a (subject, network). A NULL subject column
    # never collides in SQLite, so each subject kind has its own partial
    # index; each also serves the per-partition reads. The fold MUST stay
    # character-identical to `Grappa.IRC.Identifier.nick_fold_sql/1`, or
    # SQLite stops using the index; `IdentifierTest` pins it.
    create unique_index(:e2e_requests, ["user_id", "network_id", @folded_peer],
             name: :e2e_requests_user_network_peer_folded_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:e2e_requests, ["visitor_id", "network_id", @folded_peer],
             name: :e2e_requests_visitor_network_peer_folded_index,
             where: "visitor_id IS NOT NULL"
           )
  end

  def down do
    execute(~s{DROP TABLE "e2e_requests"})
  end
end
