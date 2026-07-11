defmodule Grappa.Repo.Migrations.XorFkNetworkCredentials do
  @moduledoc """
  #211 phase 1 — promote `network_credentials` to the subject-XOR FK
  shape so a credential can belong to EITHER a user OR a visitor.

  ## Why a table-recreate (not ALTER ADD COLUMN)

  Pre-#211 `network_credentials` had a composite `PRIMARY KEY
  (user_id, network_id)` with `user_id NOT NULL`. A composite-PK column
  cannot be NULL, but a visitor credential carries `user_id IS NULL`
  (its subject is `visitor_id`). And sqlite rejects both `ALTER TABLE
  ADD CONSTRAINT` and dropping a PK in place. So this is the same
  table-recreate dance the downstream XOR tables already use
  (`20260515005117_xor_fk_user_settings.exs` is the template):

    * drop the composite PK for a surrogate `id INTEGER PRIMARY KEY
      AUTOINCREMENT` (every already-XOR table — read_cursors,
      query_windows, user_settings — carries a surrogate id; none keep
      a composite),
    * make `user_id` nullable, add `visitor_id TEXT NULL REFERENCES
      visitors(id) ON DELETE CASCADE`,
    * add `CONSTRAINT network_credentials_subject_xor CHECK
      ((user_id IS NULL) <> (visitor_id IS NULL))`,
    * PRESERVE the `auth_method_enum` CHECK verbatim (drift-tested by
      `Grappa.Migrations.CheckConstraintsTest` — must stay
      character-identical),
    * replace the composite uniqueness with TWO partial unique indexes:
      `(user_id, network_id) WHERE user_id IS NOT NULL` and
      `(visitor_id, network_id) WHERE visitor_id IS NOT NULL`.

  The surrogate `id` is invisible to every caller: all key by
  `(subject_id, network_id)` via `Repo.get_by`/`where`, never by PK
  struct identity (verified across the credentials context + admission +
  networks). The named user index
  `network_credentials_user_id_network_id_index` — which the changeset's
  `unique_constraint/3` already references but which NO migration ever
  actually created (the composite PK provided the uniqueness) — is
  finally created here, alongside its visitor twin.

  ## Column carry-forward (frozen snapshot)

  This recreate spells out the FULL current column set: the original
  create (`20260426000002`) + the `check_constraints` recreate
  (`20260504020002`) + three subsequent alters —
  `connection_state`/`_reason`/`_changed_at` (`20260504120000`),
  `last_joined_channels` (`20260510170000`), `ident` (`20260711120000`).
  A future recreate copying this pattern MUST bring forward every column
  added since (same fragility flag as the `messages` recreate).

  ## Nothing FK-references network_credentials

  Grepped: zero `references(:network_credentials)` in the schema. So the
  recreate is self-contained — no dependent-table FK refresh needed
  (unlike the `networks` recreate in `20260504020002`). We still set
  `PRAGMA defer_foreign_keys=ON` inside the txn so the credential rows'
  OWN FK refs (users / networks) don't trip during the rename+drop.

  ## Cold deploy

  New migration — the hot deploy path skips `ecto.migrate`. MUST be
  cold-deployed (rides the combined #152 + #200 + #211-phase-1 COLD
  window) or the first query against the reshaped table 500s.
  """
  use Ecto.Migration

  def up do
    execute("PRAGMA defer_foreign_keys=ON")

    execute("ALTER TABLE network_credentials RENAME TO network_credentials_old")

    execute("""
    CREATE TABLE "network_credentials" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NULL CONSTRAINT "network_credentials_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "network_credentials_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_credentials_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      "nick" TEXT NOT NULL,
      "ident" TEXT NULL,
      "realname" TEXT NULL,
      "sasl_user" TEXT NULL,
      "password_encrypted" BLOB NULL,
      "auth_method" TEXT NOT NULL,
      "auth_command_template" TEXT NULL,
      "autojoin_channels" TEXT DEFAULT '[]' NOT NULL,
      "last_joined_channels" TEXT DEFAULT '[]' NOT NULL,
      "connection_state" TEXT DEFAULT 'connected' NOT NULL,
      "connection_state_reason" TEXT NULL,
      "connection_state_changed_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "network_credentials_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "auth_method_enum" CHECK (auth_method IN ('auto','sasl','server_pass','nickserv_identify','none'))
    )
    """)

    # Every existing row is a user credential → visitor_id NULL. The
    # surrogate id is fresh AUTOINCREMENT (omitted from the column list).
    execute("""
    INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, ident, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, last_joined_channels, connection_state, connection_state_reason, connection_state_changed_at, inserted_at, updated_at)
    SELECT user_id, NULL, network_id, nick, ident, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, last_joined_channels, connection_state, connection_state_reason, connection_state_changed_at, inserted_at, updated_at
    FROM network_credentials_old
    """)

    execute("DROP TABLE network_credentials_old")

    # Partial unique indexes — one per subject branch. WHERE ... IS NOT
    # NULL keeps NULL pairs out so a user row and a visitor row never
    # collide on the index. The user index name matches the constraint
    # the changeset's `unique_constraint(:user_id, name: ...)` expects.
    create unique_index(:network_credentials, [:user_id, :network_id],
             name: :network_credentials_user_id_network_id_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:network_credentials, [:visitor_id, :network_id],
             name: :network_credentials_visitor_id_network_id_index,
             where: "visitor_id IS NOT NULL"
           )

    # Non-unique lookup indexes preserved from the prior schema
    # (Bootstrap + per-subject listing hot paths).
    create index(:network_credentials, [:user_id])
    create index(:network_credentials, [:visitor_id])
    create index(:network_credentials, [:network_id])

    # Preserve the connection_state partial index (`20260512083037`) —
    # the recreate dropped it with the old table; Bootstrap's
    # `list_credentials_for_all_users/0` WHERE connection_state =
    # 'connected' relies on it.
    create index(:network_credentials, [:connection_state],
             where: "connection_state = 'connected'",
             name: :network_credentials_connection_state_connected_index
           )
  end

  def down do
    execute("PRAGMA defer_foreign_keys=ON")

    # Reverse to the composite-PK, user-only shape. Visitor credentials
    # (user_id IS NULL) cannot survive a composite PK with NOT NULL
    # user_id, so they are dropped — the WHERE filters them out. This
    # is the documented one-way risk of rolling back an expand: phase 1
    # is expand-only + additive, so a rollback simply reverts to the
    # pre-#211 user-only world (the backfilled visitor credentials are
    # discarded; the visitor rows themselves are untouched and keep
    # their own identity columns, so no visitor data is lost).
    execute("ALTER TABLE network_credentials RENAME TO network_credentials_new")

    execute("""
    CREATE TABLE "network_credentials" (
      "user_id" TEXT NOT NULL CONSTRAINT "network_credentials_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_credentials_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      "nick" TEXT NOT NULL,
      "ident" TEXT NULL,
      "realname" TEXT NULL,
      "sasl_user" TEXT NULL,
      "password_encrypted" BLOB NULL,
      "auth_method" TEXT NOT NULL,
      "auth_command_template" TEXT NULL,
      "autojoin_channels" TEXT DEFAULT '[]' NOT NULL,
      "last_joined_channels" TEXT DEFAULT '[]' NOT NULL,
      "connection_state" TEXT DEFAULT 'connected' NOT NULL,
      "connection_state_reason" TEXT NULL,
      "connection_state_changed_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      PRIMARY KEY ("user_id","network_id"),
      CONSTRAINT "auth_method_enum" CHECK (auth_method IN ('auto','sasl','server_pass','nickserv_identify','none'))
    )
    """)

    execute("""
    INSERT INTO network_credentials (user_id, network_id, nick, ident, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, last_joined_channels, connection_state, connection_state_reason, connection_state_changed_at, inserted_at, updated_at)
    SELECT user_id, network_id, nick, ident, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, last_joined_channels, connection_state, connection_state_reason, connection_state_changed_at, inserted_at, updated_at
    FROM network_credentials_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE network_credentials_new")

    create index(:network_credentials, [:user_id])
    create index(:network_credentials, [:network_id])

    create index(:network_credentials, [:connection_state],
             where: "connection_state = 'connected'",
             name: :network_credentials_connection_state_connected_index
           )
  end
end
