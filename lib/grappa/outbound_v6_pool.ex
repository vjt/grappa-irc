defmodule Grappa.OutboundV6Pool do
  @moduledoc """
  Source-address pool for outbound IRC connections.

  ## Why

  When the host has multiple v6 addresses (vanity-domain reverse-DNS,
  multi-IP jails, etc.), the kernel's RFC 6724 source-address
  selection is deterministic — every outbound connection picks the
  same source. This module lets the operator hand `Grappa.IRC.Client`
  a randomly-chosen source per `do_connect` call so each upstream
  IRC server sees a rotating rDNS identity.

  ## Lifecycle

  Pool is configured via `GRAPPA_OUTBOUND_V6_POOL` env (CSV of v6
  addresses) and parsed at boot in `config/runtime.exs`. Stored in
  `:persistent_term` via `boot/0` for lock-free runtime reads
  (mirrors `Grappa.Uploads.boot/1` + `Grappa.Push.boot/0` — the
  CLAUDE.md-designated `Application.get_env` boundary site).

  `pick/0` returns `{:ok, ip}` for a random pool entry or `:none`
  when the pool is empty (default). Empty pool = kernel-default
  source selection (current behavior pre-feature).
  """

  use Boundary, top_level?: true, deps: []

  @key {__MODULE__, :pool}
  @raw_key {__MODULE__, :raw_pool}

  @doc """
  Boot-time hook: reads `:grappa, :outbound_v6_pool` (already parsed
  in `config/runtime.exs`) and stashes the address list in
  `:persistent_term`. Called from `Grappa.Application.start/2`.

  An empty list is legal — `pick/0` returns `:none` and the Client
  falls through to kernel-default source selection.
  """
  @spec boot() :: :ok
  def boot do
    pool = Application.get_env(:grappa, :outbound_v6_pool, [])
    :persistent_term.put(@raw_key, pool)
    :persistent_term.put(@key, pool)
    :ok
  end

  @doc """
  Returns a random pool address as a `:inet.ip6_address/0` tuple,
  or `:none` when the pool is empty. Each call rolls independently.
  """
  @spec pick() :: {:ok, :inet.ip6_address()} | :none
  def pick do
    case :persistent_term.get(@key, []) do
      [] -> :none
      [single] -> {:ok, single}
      pool -> {:ok, Enum.random(pool)}
    end
  end

  @doc """
  Installs an *effective* pool = `raw_pool/0 -- exclusions`, written to
  the `:persistent_term` key `pick/0` reads. `exclusion_ips` is a list
  of literal IP strings (the configured per-server `source_address`es);
  each is normalized to an `:inet` IP tuple before the set difference so
  string-format differences (`::1` vs `0:0:..:1`) can't leak a dedicated
  IP back into the pool. v4 exclusions against the v6 pool are disjoint
  by family — a harmless no-op.

  Idempotent: recomputes from the immutable raw pool every call, so
  re-running with the same or an expanded exclusion set is safe. Called
  by `Grappa.Bootstrap` before it spawns any session (spec §3).
  """
  @spec apply_exclusions([String.t()]) :: :ok
  def apply_exclusions(exclusion_ips) when is_list(exclusion_ips) do
    excluded = exclusion_ips |> Enum.map(&normalize/1) |> MapSet.new()
    effective = Enum.reject(raw_pool(), &MapSet.member?(excluded, &1))
    :persistent_term.put(@key, effective)
    :ok
  end

  @doc """
  The raw env-derived pool, before any exclusions. Operator-facing
  surface for the `--source already in GRAPPA_OUTBOUND_V6_POOL` notice
  in `mix grappa.bind_network` / `grappa.add_server`.
  """
  @spec raw_pool() :: [:inet.ip6_address()]
  def raw_pool, do: :persistent_term.get(@raw_key, [])

  # Source strings are already validated strict literals at the
  # Server changeset boundary, so a parse failure here is a broken
  # invariant — let it crash loud rather than silently drop an
  # exclusion (which would leak a dedicated IP into the visitor pool).
  @spec normalize(String.t()) :: :inet.ip_address()
  defp normalize(ip_string) do
    {:ok, tuple} = :inet.parse_address(String.to_charlist(ip_string))
    tuple
  end

  @doc """
  Parses a CSV string of v6 addresses into a list of
  `:inet.ip6_address/0` tuples. Blank/whitespace entries are skipped.
  Invalid entries raise — the bouncer must refuse to boot rather
  than silently fall back to kernel-default selection when the
  operator clearly intended a pool.

  Called from `config/runtime.exs`.
  """
  @spec parse_csv(String.t() | nil) :: [:inet.ip6_address()]
  def parse_csv(nil), do: []
  def parse_csv(""), do: []

  def parse_csv(csv) when is_binary(csv) do
    csv
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(&parse_one!/1)
  end

  defp parse_one!(addr) do
    case :inet.parse_ipv6strict_address(String.to_charlist(addr)) do
      {:ok, tuple} ->
        tuple

      {:error, reason} ->
        raise ArgumentError,
              "GRAPPA_OUTBOUND_V6_POOL: invalid v6 address #{inspect(addr)} (#{inspect(reason)})"
    end
  end
end
