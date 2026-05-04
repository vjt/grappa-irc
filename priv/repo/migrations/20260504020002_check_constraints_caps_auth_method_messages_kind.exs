defmodule Grappa.Repo.Migrations.CheckConstraintsCapsAuthMethodMessagesKind do
  @moduledoc """
  Defense-in-depth DB CHECK constraints (M-pers-7 + L-pers-1).

  Mirrors closed-set invariants already enforced at the changeset
  boundary back into the DB schema, so raw-SQL drift cannot insert
  values the application loader will then crash on (e.g. an
  `Ecto.Enum` cast raising at read-time on a corrupt `auth_method`).

  Constraints added:

    1. `networks.max_concurrent_sessions IS NULL OR >= 0`
       (`max_concurrent_sessions_non_negative`)
    2. `networks.max_per_client IS NULL OR >= 0`
       (`max_per_client_non_negative`)
    3. `network_credentials.auth_method IN
       ('auto','sasl','server_pass','nickserv_identify','none')`
       (`auth_method_enum`) — mirrors
       `Grappa.Networks.Credential.@auth_methods`.
    4. `messages.kind IN ('privmsg','notice','action','join','part',
       'quit','nick_change','mode','topic','kick')`
       (`kind_enum`) — mirrors `Grappa.Scrollback.Message.@kinds`.

  ## SQLite limitation: ALTER TABLE ADD CONSTRAINT is not supported

  Sqlite 3.40.1 (and ecto_sqlite3) reject `ALTER TABLE ... ADD
  CONSTRAINT`. The adapter raises `ArgumentError "SQLite3 does not
  support ALTER TABLE ADD CONSTRAINT"` for `create constraint/3`
  (verified empirically; also see
  `deps/ecto_sqlite3/lib/ecto/adapters/sqlite3/connection.ex`
  `execute_ddl({:create, %Constraint{}})`). The canonical sqlite
  remedy is the table-recreate dance — already established in this
  codebase (see `20260502085339_add_visitor_id_to_messages.exs` for
  the XOR-CHECK precedent on `messages`).

  ## Why we ALSO recreate `network_servers`

  Modern sqlite (>= 3.25, the default) re-writes dependent FK
  references during `ALTER TABLE RENAME`: when we rename `networks`
  → `networks_old`, every dependent table's FK ref gets auto-rewritten
  to point at `networks_old`. Once we drop `networks_old` those refs
  dangle.

  For tables we explicitly CREATE-fresh as part of the dance
  (`network_credentials`, `messages`) the new CREATE TABLE statement
  spells out `REFERENCES "networks"` so the ref ends up correct on
  its own. But `network_servers` is NOT touched by the CHECK work —
  it would be left referencing the dropped `networks_old`.

  The fix: recreate `network_servers` too, with its FK ref text
  spelled fresh as `REFERENCES "networks"`. We add no CHECK to it;
  the recreation is purely to keep the FK web internally consistent.
  Mirrors the precedent migration's "rename + recreate + copy +
  drop" dance.

  (We tried `PRAGMA legacy_alter_table=ON` to suppress the auto-
  rewrite, but it does not appear to take effect through the
  ecto_sqlite3 + Exqlite migration path — the dependent FK refs
  still got rewritten despite the PRAGMA being set on what we
  believe to be the same connection. Recreating the dependent
  table is the deterministic alternative.)

  ## Rollback

  `down/0` reverses each table by repeating the same dance with the
  CHECK clause omitted from the recreated table.

  ## Why `PRAGMA defer_foreign_keys=ON`

  First-deploy attempt failed in prod with `Exqlite.Error: FOREIGN KEY
  constraint failed` on `DROP TABLE networks_old`. Sqlite >= 3.25
  auto-rewrites dependent FK refs from `networks` → `networks_old`
  during the parent rename; the dependents (`network_servers`,
  `network_credentials`, `messages`) then point at `networks_old`,
  blocking its drop while FKs are enforced.

  Tried `PRAGMA foreign_keys=OFF` first (the canonical sqlite recipe
  per https://www.sqlite.org/lang_altertable.html#otheralter). It
  REQUIRES `@disable_ddl_transaction true` (FK pragma can't toggle
  mid-transaction). But that path hit a separate Ecto/Exqlite
  connection-pool quirk: without a pinned transaction, sequential
  `execute()` calls land on different pool connections, each with
  its own snapshot of `sqlite_master`. The CREATE INDEX after a
  rename+drop sequence saw a stale snapshot showing the index still
  on `networks_old` and crashed with "index already exists".

  `PRAGMA defer_foreign_keys=ON` works INSIDE a transaction (no
  `disable_ddl_transaction` needed). It defers FK checks to COMMIT,
  by which point all 4 tables have been recreated with fresh
  CHECK-bearing schemas + fresh FK ref text pointing back at the
  fresh `networks` (sqlite >=3.25 auto-rewrites refs during EACH
  rename, so the dependents that get recreated after networks
  inherit the up-to-date `REFERENCES "networks"` text). Verified
  empirically: the schema is consistent post-COMMIT, no dangling
  refs to `*_old` tables. Auto-resets at end of transaction.

  Trade-off vs `foreign_keys=OFF`: defer relies on the auto-rewrite
  + recreate chain to leave the schema consistent at COMMIT time;
  if a future migration adds a 5th dependent table without
  recreating it here, defer would let the dangling-ref schema
  commit. The Boundary-discipline test + the implicit FK check
  on next session boot would catch it loudly. Acceptable for the
  defense-in-depth-CHECK-constraint use case.
  """
  use Ecto.Migration

  def up do
    execute("PRAGMA defer_foreign_keys=ON")
    recreate_networks_with_check()
    recreate_network_servers_to_refresh_fk()
    recreate_network_credentials_with_check()
    recreate_messages_with_check()
  end

  def down do
    execute("PRAGMA defer_foreign_keys=ON")
    rollback_messages()
    rollback_network_credentials()
    rollback_network_servers()
    rollback_networks()
  end

  # ---------------------------------------------------------------------------
  # networks
  # ---------------------------------------------------------------------------

  defp recreate_networks_with_check do
    execute("ALTER TABLE networks RENAME TO networks_old")

    execute("""
    CREATE TABLE "networks" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      "max_concurrent_sessions" INTEGER NULL,
      "max_per_client" INTEGER NULL,
      CONSTRAINT "max_concurrent_sessions_non_negative" CHECK (max_concurrent_sessions IS NULL OR max_concurrent_sessions >= 0),
      CONSTRAINT "max_per_client_non_negative" CHECK (max_per_client IS NULL OR max_per_client >= 0)
    )
    """)

    execute("""
    INSERT INTO networks (id, slug, inserted_at, updated_at, max_concurrent_sessions, max_per_client)
    SELECT id, slug, inserted_at, updated_at, max_concurrent_sessions, max_per_client
    FROM networks_old
    """)

    execute("DROP TABLE networks_old")

    create unique_index(:networks, [:slug])
  end

  defp rollback_networks do
    execute("ALTER TABLE networks RENAME TO networks_old")

    execute("""
    CREATE TABLE "networks" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      "max_concurrent_sessions" INTEGER NULL,
      "max_per_client" INTEGER NULL
    )
    """)

    execute("""
    INSERT INTO networks (id, slug, inserted_at, updated_at, max_concurrent_sessions, max_per_client)
    SELECT id, slug, inserted_at, updated_at, max_concurrent_sessions, max_per_client
    FROM networks_old
    """)

    execute("DROP TABLE networks_old")

    create unique_index(:networks, [:slug])
  end

  # ---------------------------------------------------------------------------
  # network_servers (recreated only to refresh the FK ref; no CHECK added)
  # ---------------------------------------------------------------------------

  defp recreate_network_servers_to_refresh_fk do
    execute("ALTER TABLE network_servers RENAME TO network_servers_old")

    execute("""
    CREATE TABLE "network_servers" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_servers_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "host" TEXT NOT NULL,
      "port" INTEGER NOT NULL,
      "tls" INTEGER DEFAULT true NOT NULL,
      "priority" INTEGER DEFAULT 0 NOT NULL,
      "enabled" INTEGER DEFAULT true NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO network_servers (id, network_id, host, port, tls, priority, enabled, inserted_at, updated_at)
    SELECT id, network_id, host, port, tls, priority, enabled, inserted_at, updated_at
    FROM network_servers_old
    """)

    execute("DROP TABLE network_servers_old")

    create unique_index(:network_servers, [:network_id, :host, :port])
    create index(:network_servers, [:network_id])
  end

  defp rollback_network_servers do
    # Symmetric to recreate_network_servers_to_refresh_fk/0 — refreshes
    # the FK ref text after the parent rollback retargets `networks`.
    execute("ALTER TABLE network_servers RENAME TO network_servers_old")

    execute("""
    CREATE TABLE "network_servers" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_servers_network_id_fkey" REFERENCES "networks"("id") ON DELETE CASCADE,
      "host" TEXT NOT NULL,
      "port" INTEGER NOT NULL,
      "tls" INTEGER DEFAULT true NOT NULL,
      "priority" INTEGER DEFAULT 0 NOT NULL,
      "enabled" INTEGER DEFAULT true NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO network_servers (id, network_id, host, port, tls, priority, enabled, inserted_at, updated_at)
    SELECT id, network_id, host, port, tls, priority, enabled, inserted_at, updated_at
    FROM network_servers_old
    """)

    execute("DROP TABLE network_servers_old")

    create unique_index(:network_servers, [:network_id, :host, :port])
    create index(:network_servers, [:network_id])
  end

  # ---------------------------------------------------------------------------
  # network_credentials
  # ---------------------------------------------------------------------------

  defp recreate_network_credentials_with_check do
    execute("ALTER TABLE network_credentials RENAME TO network_credentials_old")

    execute("""
    CREATE TABLE "network_credentials" (
      "user_id" TEXT NOT NULL CONSTRAINT "network_credentials_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_credentials_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      "nick" TEXT NOT NULL,
      "realname" TEXT NULL,
      "sasl_user" TEXT NULL,
      "password_encrypted" BLOB NULL,
      "auth_method" TEXT NOT NULL,
      "auth_command_template" TEXT NULL,
      "autojoin_channels" TEXT DEFAULT '[]' NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      PRIMARY KEY ("user_id","network_id"),
      CONSTRAINT "auth_method_enum" CHECK (auth_method IN ('auto','sasl','server_pass','nickserv_identify','none'))
    )
    """)

    execute("""
    INSERT INTO network_credentials (user_id, network_id, nick, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, inserted_at, updated_at)
    SELECT user_id, network_id, nick, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, inserted_at, updated_at
    FROM network_credentials_old
    """)

    execute("DROP TABLE network_credentials_old")

    create index(:network_credentials, [:user_id])
    create index(:network_credentials, [:network_id])
  end

  defp rollback_network_credentials do
    execute("ALTER TABLE network_credentials RENAME TO network_credentials_old")

    execute("""
    CREATE TABLE "network_credentials" (
      "user_id" TEXT NOT NULL CONSTRAINT "network_credentials_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "network_credentials_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      "nick" TEXT NOT NULL,
      "realname" TEXT NULL,
      "sasl_user" TEXT NULL,
      "password_encrypted" BLOB NULL,
      "auth_method" TEXT NOT NULL,
      "auth_command_template" TEXT NULL,
      "autojoin_channels" TEXT DEFAULT '[]' NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      PRIMARY KEY ("user_id","network_id")
    )
    """)

    execute("""
    INSERT INTO network_credentials (user_id, network_id, nick, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, inserted_at, updated_at)
    SELECT user_id, network_id, nick, realname, sasl_user, password_encrypted, auth_method, auth_command_template, autojoin_channels, inserted_at, updated_at
    FROM network_credentials_old
    """)

    execute("DROP TABLE network_credentials_old")

    create index(:network_credentials, [:user_id])
    create index(:network_credentials, [:network_id])
  end

  # ---------------------------------------------------------------------------
  # messages
  # ---------------------------------------------------------------------------

  defp recreate_messages_with_check do
    execute("ALTER TABLE messages RENAME TO messages_old")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL)),
      CONSTRAINT "kind_enum" CHECK (kind IN ('privmsg','notice','action','join','part','quit','nick_change','mode','topic','kick'))
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, visitor_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, visitor_id, network_id
    FROM messages_old
    """)

    execute("DROP TABLE messages_old")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id, :network_id, :channel, :server_time])
  end

  defp rollback_messages do
    execute("ALTER TABLE messages RENAME TO messages_old")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, visitor_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, visitor_id, network_id
    FROM messages_old
    """)

    execute("DROP TABLE messages_old")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id, :network_id, :channel, :server_time])
  end
end
