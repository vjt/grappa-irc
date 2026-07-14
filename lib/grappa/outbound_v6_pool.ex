defmodule Grappa.OutboundV6Pool do
  @moduledoc """
  Source-address rotation pool for outbound IRC connections.

  ## Why

  When the host has multiple v6 addresses (vanity-domain reverse-DNS,
  multi-IP jails, etc.), the kernel's RFC 6724 source-address selection
  is deterministic — every outbound connection picks the same source.
  This module hands `Grappa.IRC.Client` a randomly-chosen source per
  `do_connect` call so each upstream IRC server sees a rotating rDNS
  identity.

  ## DB-driven (#228, vjt 2026-07-14)

  The pool USED to be parsed from the `GRAPPA_OUTBOUND_V6_POOL` env var.
  It is now the set of `vhosts` rows flagged `in_pool` — curated through
  the admin panel, no env var. `Grappa.Bootstrap` reads
  `Grappa.Vhosts.pool_addresses/0` at boot and calls `apply_pool/1`; the
  admin surface re-applies on any inventory change (hot).

  ## Boundary shape (no cycle)

  `pick/0` stays a thin lock-free `:persistent_term` read so
  `Grappa.IRC` deps only THIS module (not `Grappa.Vhosts`, which deps
  `Grappa.UserSettings` → `Grappa.IRC` — that would close a cycle). The
  DB → `persistent_term` sync is pushed IN via `apply_pool/1` from
  callers that already dep `Vhosts` (Bootstrap, the admin controller),
  never pulled from here.

  `pick/0` returns `{:ok, ip}` for a random pool entry or `:none` when
  the pool is empty (the default — kernel-default source selection,
  current behavior for an uncurated deployment).
  """

  use Boundary, top_level?: true, deps: []

  @key {__MODULE__, :pool}

  @doc """
  Boot-time hook: initializes an EMPTY pool. `Grappa.Bootstrap` calls
  `apply_pool/1` with the DB-curated `in_pool` addresses immediately
  after (before spawning any session), so a fresh boot with no curated
  pool falls through to kernel-default selection until the operator adds
  `in_pool` vhosts. Called from `Grappa.Application.start/2`.
  """
  @spec boot() :: :ok
  def boot do
    :persistent_term.put(@key, [])
    :ok
  end

  @doc """
  Installs the rotation pool from a list of source addresses — either
  IP-literal strings (from `Grappa.Vhosts.pool_addresses/0`) or already
  parsed `:inet.ip6_address/0` tuples. Only v6 addresses are kept (the
  rotation is v6-only — v4 has no vanity-rDNS rotation use case);
  malformed / v4 entries are skipped rather than raised, so a single bad
  admin row can't wedge the boot path.

  Idempotent: overwrites the whole pool every call, so re-applying after
  an inventory edit is safe. Written to the `:persistent_term` key
  `pick/0` reads.
  """
  @spec apply_pool([String.t() | :inet.ip6_address()]) :: :ok
  def apply_pool(addresses) when is_list(addresses) do
    pool = addresses |> Enum.flat_map(&to_v6_tuple/1)
    :persistent_term.put(@key, pool)
    :ok
  end

  @doc """
  Returns a random pool address as a `:inet.ip6_address/0` tuple, or
  `:none` when the pool is empty. Each call rolls independently.
  """
  @spec pick() :: {:ok, :inet.ip6_address()} | :none
  def pick do
    case :persistent_term.get(@key, []) do
      [] -> :none
      [single] -> {:ok, single}
      pool -> {:ok, Enum.random(pool)}
    end
  end

  @doc "The pool `pick/0` currently draws from. Operator/diagnostic surface."
  @spec current_pool() :: [:inet.ip6_address()]
  def current_pool, do: :persistent_term.get(@key, [])

  # A v6 tuple passes through; a v6-literal string parses; anything else
  # (v4 literal, hostname, garbage) yields [] so flat_map drops it.
  @spec to_v6_tuple(String.t() | :inet.ip_address()) :: [:inet.ip6_address()]
  defp to_v6_tuple({_, _, _, _, _, _, _, _} = tuple), do: [tuple]

  defp to_v6_tuple(address) when is_binary(address) do
    case :inet.parse_ipv6strict_address(String.to_charlist(address)) do
      {:ok, tuple} -> [tuple]
      {:error, _} -> []
    end
  end

  defp to_v6_tuple(_), do: []
end
