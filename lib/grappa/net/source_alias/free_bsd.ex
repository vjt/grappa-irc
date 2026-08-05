defmodule Grappa.Net.SourceAlias.FreeBSD do
  @moduledoc """
  FreeBSD-jail source-alias adapter (#543). Binds an address derived inside
  the configured `/80` as a `/128` alias on `lo0` through the sudoers wrapper
  `infra/freebsd/bin/grappa-source-alias`, invoked via the hardened command
  seam (`Grappa.Net.SourceAlias.Config.cmd/0`).

  The wrapper — not a bare `sudo ifconfig` — is the privilege boundary: it
  hard-codes `lo0` + `/128` and refuses any address outside its configured
  prefix (read from a root-owned config file, #609; an unconstrained `sudo
  ifconfig` is a privilege hole, Global Constraint). This adapter mirrors that
  guard in-process (`in_cidr6?/2` BEFORE shelling) so an out-of-prefix address
  never even reaches `sudo`.

  `ensure_source` / `release_source` add / delete the alias; `arm_check`
  proves the substrate can ACTUALLY alias — the wrapper's `probe` subcommand
  adds then deletes a canary derived from the prefix, so a non-VNET jail (or a
  DB↔substrate prefix drift) refuses to arm with a concrete reason instead of
  arming and failing every acquire; `list_aliases` reads `ifconfig lo0`
  (unprivileged, no sudo) and returns the inet6 addresses inside the prefix —
  the ground truth for boot reconcile.
  """

  @behaviour Grappa.Net.SourceAlias

  alias Grappa.Net.IpLiteral
  alias Grappa.Net.SourceAlias.Config

  # sudoers-scoped wrapper; resolved on the operator's secure_path (see
  # docs/OPERATIONS.md). subcommands: add | del | probe.
  @wrapper "grappa-source-alias"
  # Wall-clock ceiling for the ifconfig shell-out — an alias add/del is
  # sub-second; 10s is generous slack, not a tuning knob.
  @timeout_s 10

  @impl Grappa.Net.SourceAlias
  def arm_check(prefix) do
    case IpLiteral.network_address(prefix) do
      {:ok, canary} ->
        # Prove the substrate can ACTUALLY alias, not just that the sudoers
        # grant resolves (the old no-op `check` was a false positive). The
        # wrapper's `probe` adds then deletes the canary; `-n` (non-interactive)
        # turns a missing grant into an immediate non-zero instead of a
        # password prompt that would hang boot. The canary is the network base
        # of THIS prefix (the DB prefix), so a wrapper scoped to a different
        # config-file prefix refuses it (exit 65) — surfacing a DB↔substrate
        # drift here as :prefix_mismatch rather than as per-address failures.
        result = Config.cmd().run("sudo", ["-n", @wrapper, "probe", canary], @timeout_s)
        arm_reason(result)

      :error ->
        {:error, :invalid_prefix}
    end
  end

  # Map the wrapper's exit code (HardenedCmd surfaces it as {:exit, code, _})
  # to the concrete refuse-to-arm reason — the wrapper's exit-code contract:
  # 65 out-of-prefix (a DB↔substrate prefix drift), 66 prefix config
  # unavailable, 69 substrate refused the alias (e.g. non-VNET jail). Any other
  # non-zero (sudo's own exit 1 on a missing NOPASSWD grant) means the wrapper
  # is not reachable at all.
  defp arm_reason({:ok, _}), do: :ok
  defp arm_reason({:error, {:exit, 65, _}}), do: {:error, :prefix_mismatch}
  defp arm_reason({:error, {:exit, 66, _}}), do: {:error, :prefix_config_unavailable}
  defp arm_reason({:error, {:exit, 69, _}}), do: {:error, :alias_not_permitted}
  defp arm_reason({:error, {:exit, _, _}}), do: {:error, :wrapper_unavailable}
  defp arm_reason({:error, :timeout}), do: {:error, :probe_timeout}
  defp arm_reason({:error, {:exe_not_found, _}}), do: {:error, :wrapper_unavailable}

  @impl Grappa.Net.SourceAlias
  def ensure_source(addr, prefix), do: alias_op("add", addr, prefix)

  @impl Grappa.Net.SourceAlias
  def release_source(addr, prefix), do: alias_op("del", addr, prefix)

  @impl Grappa.Net.SourceAlias
  # #627 — no prefix means mode 2 is unconfigured: no block to list aliases
  # inside, so the answer is empty WITHOUT shelling `ifconfig`. Belt-and-braces
  # with the manager's reconcile early-return — keeps the adapter contract
  # total (never raises) for the nil prefix of a mode-1 / fresh install, rather
  # than parsing `lo0` and filtering `::1` through `in_cidr6?(_, nil)`.
  def list_aliases(nil), do: {:ok, []}

  def list_aliases(prefix) when is_binary(prefix) do
    case Config.cmd().run("ifconfig", ["lo0"], @timeout_s) do
      {:ok, output} -> {:ok, parse_lo0_inet6(output, prefix)}
      {:error, _} = err -> err
    end
  end

  # Guard in-prefix BEFORE shelling — the process must never attempt an
  # out-of-scope ifconfig even though the wrapper would also refuse it.
  defp alias_op(subcommand, addr, prefix) do
    if IpLiteral.in_cidr6?(addr, prefix) do
      case Config.cmd().run("sudo", [@wrapper, subcommand, addr], @timeout_s) do
        {:ok, _} -> :ok
        {:error, _} = err -> err
      end
    else
      {:error, :outside_prefix}
    end
  end

  # Extract the inet6 addresses from `ifconfig lo0` output that fall inside
  # `prefix`. Lines look like `\tinet6 2001:db8:1:2:cafe::1 prefixlen 128`;
  # a link-local carries a `%lo0` zone we strip before the membership test.
  #
  # Each address is CANONICALIZED (`IpLiteral.canonicalize/1`, i.e. the same
  # `:inet.ntoa` form the manager's held keys carry) before it is returned, so
  # the reconcile set-diff (OS-bound vs held) compares like-for-like. Without
  # this, `ifconfig`'s spelling of an address vs `SourceMapping.derive/2`'s
  # (`:inet.ntoa`) could differ for the same address and reconcile would
  # classify a live, held alias as an orphan and release it — an outage-class
  # trap once INC-6 wires real holders. An unparseable token is dropped.
  defp parse_lo0_inet6(output, prefix) do
    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(&inet6_addr/1)
    |> Enum.filter(&IpLiteral.in_cidr6?(&1, prefix))
  end

  # One canonical inet6 address from an `ifconfig` line (zone stripped), or []
  # for a non-inet6 line / unparseable token.
  defp inet6_addr(line) do
    case line |> String.trim() |> String.split() do
      ["inet6", addr | _] -> canonical_or_drop(addr)
      _ -> []
    end
  end

  defp canonical_or_drop(addr) do
    case addr |> String.split("%") |> hd() |> IpLiteral.canonicalize() do
      {:ok, canon} -> [canon]
      :error -> []
    end
  end
end
