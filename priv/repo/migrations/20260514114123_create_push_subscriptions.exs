defmodule Grappa.Repo.Migrations.CreatePushSubscriptions do
  @moduledoc """
  Push notifications cluster B1 (2026-05-14) — Web Push subscription
  storage.

  Per-(user, device) row carrying the three opaque fields the W3C
  Push API hands out: `endpoint` (the vendor-operated push URL),
  `p256dh_key` (subscriber public key), `auth_key` (auth secret).
  Plus per-device metadata for the "see + revoke my devices" UX:
  `user_agent` (best-effort device identifier from the originating
  POST's Accept-Encoding chain) and `last_used_at` (set on each
  successful Push.Sender delivery, clears stale entries).

  ## User-only

  Visitors are ephemeral by design (W9 sliding TTL, per-anon
  reaping); a push subscription tied to a visitor would outlive the
  visitor row and either dangle or block deletion. Push subscriptions
  are an opt-in PWA-installed feature; visitors don't install the
  PWA. So `user_id` is NOT NULL with `ON DELETE CASCADE` — when an
  operator deletes a user, their subscriptions go too.

  ## Uniqueness

  `(user_id, endpoint)` is unique — re-subscribing from the same
  device returns the same endpoint URL, so the upsert path replaces
  the keys in place rather than creating duplicates. Endpoint URLs
  are vendor-specific opaque tokens that may exceed 1KB
  (Mozilla's autopush endpoints push past 200 bytes; Chrome's FCM
  endpoints are shorter); declared `:text` with no length cap, the
  schema-layer changeset enforces a defensive 2048-byte cap.

  ## Cold-deploy required

  New table → COLD deploy per `feedback_cluster_with_migration_must
  _cold`. Hot path skips `mix ecto.migrate`; first query post-
  reload would 500.
  """
  use Ecto.Migration

  def change do
    create table(:push_subscriptions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :user_id,
          references(:users, type: :binary_id, on_delete: :delete_all),
          null: false

      add :endpoint, :text, null: false
      add :p256dh_key, :text, null: false
      add :auth_key, :text, null: false
      add :user_agent, :text
      add :last_used_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    # The unique `(user_id, endpoint)` index is sufficient — sqlite
    # uses it as a left-prefix scan for queries that filter on
    # `user_id` alone (e.g. `Push.list_for_user/1`'s `where: s.user_id
    # == ^user_id`), so a separate plain `(user_id)` index would be
    # redundant. Default index name `push_subscriptions_user_id
    # _endpoint_index` is what the schema's `unique_constraint`
    # matches against (relying on Ecto's auto-name shape rather than
    # an explicit `name:` opt — keeps the changeset and migration
    # constraint name auto-aligned).
    create unique_index(:push_subscriptions, [:user_id, :endpoint])
  end
end
