defmodule Grappa.Repo.Migrations.SeedVhostPoolFromEnv do
  @moduledoc """
  #228 — carry the current `GRAPPA_OUTBOUND_V6_POOL` env value into the
  DB-driven vhost inventory so the outbound rotation pool is byte-identical
  the instant this deploy lands (vjt 2026-07-14 "migration auto-seeds").

  Before #228 the rotation pool was parsed from `GRAPPA_OUTBOUND_V6_POOL`
  at boot. After #228 the pool is the set of `vhosts` rows flagged
  `in_pool`. This data migration reads the env var AT MIGRATE TIME (the
  operator runs the migration in the deploy environment where the var is
  still set) and inserts each address as an `in_pool` vhost.

  The one prod account pinned to a dedicated host needs NO seeding: its
  `network_servers.source_address` is still honored as the per-network
  fallback in `Grappa.Vhosts.effective_source/2`, so that account keeps
  egressing from its dedicated /128 with zero migration action.

  Idempotent: `INSERT OR IGNORE` on the `vhosts_address_index` unique
  index, so re-running (or a partial pool already curated) is safe.
  `down/0` is a no-op — we do NOT delete curated inventory on rollback
  (the addresses may have been edited via the admin panel since).
  """
  use Ecto.Migration

  def up do
    now = DateTime.utc_now() |> DateTime.to_iso8601()

    "GRAPPA_OUTBOUND_V6_POOL"
    |> System.get_env()
    |> parse_csv()
    |> Enum.each(fn address ->
      execute("""
      INSERT OR IGNORE INTO vhosts (address, in_pool, generally_available, inserted_at, updated_at)
      VALUES ('#{address}', 1, 0, '#{now}', '#{now}')
      """)
    end)
  end

  def down, do: :ok

  # Parse the CSV the same way the retired OutboundV6Pool.parse_csv did:
  # strict v6 literals, canonicalized to the stored form. Invalid entries
  # are skipped (a data migration must not crash the deploy over a stale
  # env typo — the schema changeset guards the admin write path).
  defp parse_csv(nil), do: []
  defp parse_csv(""), do: []

  defp parse_csv(csv) when is_binary(csv) do
    csv
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.flat_map(&canonical_v6/1)
    |> Enum.uniq()
  end

  defp canonical_v6(address) do
    case :inet.parse_ipv6strict_address(String.to_charlist(address)) do
      {:ok, tuple} -> [to_string(:inet.ntoa(tuple))]
      {:error, _} -> []
    end
  end
end
