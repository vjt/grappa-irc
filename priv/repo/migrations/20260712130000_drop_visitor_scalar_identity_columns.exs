defmodule Grappa.Repo.Migrations.DropVisitorScalarIdentityColumns do
  @moduledoc """
  #211 phase 7 (THE CONTRACT) — drop the per-network identity scalars from
  the `visitors` table, leaving a pure identity/TTL row.

  ## What drops

  Columns: `network_slug, nick, ident, realname, password_encrypted,
  last_joined_channels`. Index: `visitors_nick_folded_network_slug_index`
  (the rfc1459-folded-nick unique expression index).

  ## What stays

  The surrogate `id` (binary_id PK — every `visitor_id` FK on
  `network_credentials` + the subject-XOR tables points at it),
  `expires_at` (the TTL / anon-vs-registered axis), `ip` (operator audit),
  `inserted_at`/`updated_at`, and the non-unique `expires_at` + `ip`
  lookup indexes.

  ## Why native DROP COLUMN, NOT a table-recreate (spec deviation)

  The phase-6 design called for the phase-1 table-recreate technique
  (rename-aside + CREATE + INSERT...SELECT + DROP + rename) to avoid
  SQLite's fragility dropping a column that backs an EXPRESSION index. But
  that technique is UNSAFE for `visitors`: it is a PARENT table with SEVEN
  inbound FKs (`network_credentials`, `messages`, `accounts_sessions`,
  `read_cursors`, `query_windows`, `push_subscriptions`, `user_settings`),
  and SQLite ≥3.25 AUTO-REWRITES every child FK's `REFERENCES visitors`
  text to `REFERENCES visitors_old` the instant the parent is renamed —
  so after the final `DROP TABLE visitors_old` all seven children carry
  DANGLING FKs (the first `INSERT INTO network_credentials` then fails
  with `no such table: visitors_old`). The phase-1 recreate was safe only
  because `network_credentials` had ZERO inbound FKs. Recreating all seven
  children just to refresh their FK text would be a huge, fragile diff.

  The expression-index fragility the recreate was meant to dodge is fully
  handled by dropping that index FIRST, then issuing native
  `ALTER TABLE ... DROP COLUMN` (SQLite ≥3.35, supported by ecto_sqlite3).
  DROP COLUMN does NOT rename the table, so NO child FK is ever rewritten —
  the FK web stays internally consistent. The folded-nick UNIQUENESS lives
  on `network_credentials` now (the phase-4b
  `network_credentials_visitor_folded_nick_network_id_index`), so dropping
  the visitors-table twin loses nothing.

  ## Cold deploy — IRREVERSIBLE

  New migration — the hot deploy path skips `ecto.migrate`, so this MUST be
  cold-deployed. The column DROP is IRREVERSIBLE: the identity scalars are
  gone from the row (they live on the credentials, backfilled since phase
  1). `down/0` re-adds the columns as NULLable + rebuilds the folded index
  + best-effort restores nick/ident/realname from each visitor's
  representative credential, but a full data restore requires the
  pre-deploy DB backup — hence the phase-7 deploy is gated on a fresh
  backup + prod-DB dry-runs.
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, in pure SQL — character-identical
  # to `Grappa.IRC.Identifier.nick_fold/1` and the phase-1/4b index SQL, or
  # SQLite won't use the rebuilt index on `down/0`. Inlined (migrations
  # stay self-contained, no module dep under a truncated code load).
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    # Drop the expression index FIRST — a column backing an index can't be
    # dropped while the index exists.
    drop unique_index(:visitors, ["#{fold("nick")}", "network_slug"],
           name: :visitors_nick_folded_network_slug_index
         )

    # Native DROP COLUMN per column — no table rename, so no child FK is
    # rewritten (the FK-rewrite trap that makes a table-recreate unsafe on
    # this parent table — see moduledoc). None of these columns backs a
    # remaining index (the expires_at/ip indexes stay; the folded index is
    # gone above), so each drop is clean.
    alter table(:visitors) do
      remove :network_slug
      remove :nick
      remove :ident
      remove :realname
      remove :password_encrypted
      remove :last_joined_channels
    end
  end

  def down do
    # Re-add the dropped columns. `nick`/`network_slug` were NOT NULL in the
    # original schema, but the data is gone (it lives on the credentials
    # now), so they come back NULLable — a full rollback is a
    # backup-restore, not an in-place inverse (documented in the moduledoc).
    alter table(:visitors) do
      add :network_slug, :string
      add :nick, :string
      add :ident, :string
      add :realname, :string
      add :password_encrypted, :binary
      add :last_joined_channels, :text, null: false, default: "[]"
    end

    # Best-effort identity restore: pull nick/ident/realname + the network
    # slug from each visitor's REPRESENTATIVE (lowest network_id) credential
    # so the reverted rows aren't identity-blank. Password stays NULL (a
    # genuine restore uses the pre-deploy backup).
    execute("""
    UPDATE visitors
    SET
      nick = (
        SELECT c.nick FROM network_credentials c
        WHERE c.visitor_id = visitors.id
        ORDER BY c.network_id ASC LIMIT 1
      ),
      ident = (
        SELECT c.ident FROM network_credentials c
        WHERE c.visitor_id = visitors.id
        ORDER BY c.network_id ASC LIMIT 1
      ),
      realname = (
        SELECT c.realname FROM network_credentials c
        WHERE c.visitor_id = visitors.id
        ORDER BY c.network_id ASC LIMIT 1
      ),
      network_slug = (
        SELECT n.slug FROM network_credentials c
        JOIN networks n ON n.id = c.network_id
        WHERE c.visitor_id = visitors.id
        ORDER BY c.network_id ASC LIMIT 1
      )
    """)

    create unique_index(:visitors, ["#{fold("nick")}", "network_slug"],
             name: :visitors_nick_folded_network_slug_index
           )
  end
end
