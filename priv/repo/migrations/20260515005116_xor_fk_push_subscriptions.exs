defmodule Grappa.Repo.Migrations.XorFkPushSubscriptions do
  @moduledoc """
  visitor-parity V1.b — promotes `push_subscriptions` to the XOR FK
  shape.

  Same table-recreate dance as V1.a (see
  `20260515005115_xor_fk_query_windows`). The `id` column is a TEXT
  binary_id (UUID) per the original push-subscription schema, so the
  recreate clones that primary-key shape.
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE push_subscriptions RENAME TO push_subscriptions_old")

    execute("""
    CREATE TABLE "push_subscriptions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NULL CONSTRAINT "push_subscriptions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "push_subscriptions_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "endpoint" TEXT NOT NULL,
      "p256dh_key" TEXT NOT NULL,
      "auth_key" TEXT NOT NULL,
      "user_agent" TEXT NULL,
      "last_used_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      CONSTRAINT "push_subscriptions_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO push_subscriptions
      (id, user_id, visitor_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at)
    SELECT
      id, user_id, NULL, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at
    FROM push_subscriptions_old
    """)

    execute("DROP TABLE push_subscriptions_old")

    create unique_index(:push_subscriptions, [:user_id, :endpoint],
             name: :push_subscriptions_user_id_endpoint_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:push_subscriptions, [:visitor_id, :endpoint],
             name: :push_subscriptions_visitor_id_endpoint_index,
             where: "visitor_id IS NOT NULL"
           )

    create index(:push_subscriptions, [:user_id], where: "user_id IS NOT NULL")
    create index(:push_subscriptions, [:visitor_id], where: "visitor_id IS NOT NULL")
  end

  def down do
    execute("ALTER TABLE push_subscriptions RENAME TO push_subscriptions_new")

    execute("""
    CREATE TABLE "push_subscriptions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL CONSTRAINT "push_subscriptions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "endpoint" TEXT NOT NULL,
      "p256dh_key" TEXT NOT NULL,
      "auth_key" TEXT NOT NULL,
      "user_agent" TEXT NULL,
      "last_used_at" TEXT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    )
    """)

    execute("""
    INSERT INTO push_subscriptions
      (id, user_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at)
    SELECT
      id, user_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at, inserted_at, updated_at
    FROM push_subscriptions_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE push_subscriptions_new")

    create unique_index(:push_subscriptions, [:user_id, :endpoint])
  end
end
