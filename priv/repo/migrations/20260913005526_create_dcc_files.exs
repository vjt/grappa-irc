defmodule Grappa.Repo.Migrations.CreateDccFiles do
  use Ecto.Migration

  # issue 2089 — the DCC RECEIVE spool: bytes a PEER pushed at one of our
  # subjects over `DCC SEND`, after that subject explicitly accepted the
  # offer.
  #
  # A THIRD table rather than a flag on `uploads`, for the reason
  # `peer_avatars` is a second one: a subject-owned upload is content OUR
  # user chose to publish, and this is content a STRANGER chose to push.
  # Different trust domains, and CLAUDE.md is explicit that a shared data
  # model with a type flag across two of them is a boundary violation
  # rather than reuse. The on-disk mechanics (slug filename under a
  # storage root) are deliberately identical; the ownership,
  # the retention rule and the serving route are not.
  #
  # `expires_at` is NOT NULL, and that is the whole of vjt's retention
  # ruling expressed in DDL. In `uploads`, NULL means NEVER EXPIRES
  # (`Grappa.Uploads.list_expired/1` enumerates `not is_nil(expires_at)`
  # only), and `UserSettings.get_upload_ttl_seconds/1` returns nil for
  # every subject who has never touched the setting — i.e. the DEFAULT. So
  # reusing that column's nullability here would have meant that for the
  # average user a stranger's bytes stay forever, which is the exact
  # inverse of "nothing stranger-pushed persists un-reaped". The column
  # cannot hold NULL, so the hard cap cannot be bypassed by a subject
  # setting; `Grappa.Dcc.retention_seconds/1` computes the value.
  #
  # No `mime` column, deliberately, unlike both sibling tables. Every byte
  # here is served `application/octet-stream` + `attachment` + `nosniff`,
  # because issue 2089 forbids promoting a type from stranger-supplied
  # content. A column would be a place for a sniffed or peer-claimed type
  # to accumulate and eventually be trusted.
  #
  # No `deleted_at` either: `uploads` soft-deletes because a PUBLIC,
  # cacheable URL can be in flight when the reaper runs. This spool is
  # served only behind `:authn` + `ResolveNetwork`, so it hard-deletes the
  # way `peer_avatars` does — file unlinked first, then the row.
  def change do
    # Raw SQL for the table body, mirroring `create_uploads_and_server_settings`
    # and `create_vhosts`: the subject XOR is a CHECK constraint, which
    # `Ecto.Migration`'s DSL cannot express inline.
    execute(
      """
      CREATE TABLE "dcc_files" (
        "id" TEXT PRIMARY KEY,
        "slug" TEXT NOT NULL,
        "user_id" TEXT NULL CONSTRAINT "dcc_files_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
        "visitor_id" TEXT NULL CONSTRAINT "dcc_files_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
        "network_id" INTEGER NOT NULL CONSTRAINT "dcc_files_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
        "peer_nick" TEXT NOT NULL,
        "filename" TEXT NOT NULL,
        "bytes" INTEGER NOT NULL,
        "expires_at" TEXT NOT NULL,
        "inserted_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        CONSTRAINT "dcc_files_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
      )
      """,
      ~s{DROP TABLE "dcc_files"}
    )

    create unique_index(:dcc_files, [:slug])

    # The reaper's enumeration (`Grappa.Dcc.list_expired/1`). No partial
    # predicate, unlike `uploads`: the column is NOT NULL here, so every
    # row is in scope by construction and there is no soft-delete to skip.
    create index(:dcc_files, [:expires_at])

    # The serving route's lookup is `(subject, network_id, slug)`, and the
    # unique slug index already answers it. This one backs the LIST door
    # and the per-subject accounting the accept-time cap needs.
    create index(:dcc_files, [:user_id, :network_id])
    create index(:dcc_files, [:visitor_id, :network_id])
  end
end
