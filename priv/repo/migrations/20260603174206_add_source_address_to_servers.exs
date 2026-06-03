defmodule Grappa.Repo.Migrations.AddSourceAddressToServers do
  @moduledoc """
  Per-server outbound source address. A non-NULL `source_address` is a
  literal IPv4/IPv6 the IRC client binds as the connection's source
  (bypassing the rotating `OutboundV6Pool`); NULL keeps the existing
  pool/kernel-default path. Validated to a strict IP literal at the
  `Grappa.Networks.Server` changeset boundary — the column is plain text.

  Spec: docs/superpowers/specs/2026-06-03-per-server-source-address-design.md
  """
  use Ecto.Migration

  def change do
    alter table(:network_servers) do
      add :source_address, :string, null: true
    end
  end
end
