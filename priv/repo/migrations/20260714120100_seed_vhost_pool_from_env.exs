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

  require Logger

  def up do
    now = DateTime.utc_now() |> DateTime.to_iso8601()
    addresses = "GRAPPA_OUTBOUND_V6_POOL" |> System.get_env() |> parse_csv()

    # Log-honesty + deploy-safety: if the env var is unset at migrate time
    # (e.g. a mis-ordered deploy that dropped it before ecto.migrate ran),
    # the rotation pool would silently seed EMPTY — outbound rDNS
    # identities lost until re-curated. Make that loud rather than silent.
    case System.get_env("GRAPPA_OUTBOUND_V6_POOL") do
      nil ->
        Logger.warning(
          "seed_vhost_pool_from_env: GRAPPA_OUTBOUND_V6_POOL is UNSET — seeding 0 in_pool " <>
            "vhosts. If this deploy expected a rotation pool, the env var was dropped before " <>
            "ecto.migrate ran; curate in_pool vhosts via the admin panel."
        )

      _ ->
        Logger.info("seed_vhost_pool_from_env: seeding #{length(addresses)} in_pool vhost(s)")
    end

    Enum.each(addresses, fn address ->
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
  #
  # SQL-injection safe BY CONSTRUCTION: `canonical_v6/1` runs every entry
  # through :inet.parse_ipv6strict_address + :inet.ntoa, so only canonical
  # hex/colon literals reach the interpolated string — a quote or any
  # non-literal byte fails the strict parse and is dropped. Do NOT loosen
  # the parse without switching to a parameterized insert.
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
