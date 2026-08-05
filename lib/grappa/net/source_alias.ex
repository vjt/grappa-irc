defmodule Grappa.Net.SourceAlias do
  @moduledoc """
  Platform adapter behaviour for binding a derived outbound source address
  (the derivation `/80`, #543 `static_mapping_with_reservations`) to the host so
  the upstream socket can `bind()` to it.

  Each substrate provisions a source address differently:

    * **FreeBSD jail (`:jail`)** — `Grappa.Net.SourceAlias.FreeBSD`. Adds a
      per-address `/128` alias on `lo0` through a sudoers-scoped wrapper
      (`infra/freebsd/bin/grappa-source-alias`). Ref-counted: bound on the
      first session that needs it, removed on the last.
    * **Linux (`:linux`)** — `Grappa.Net.SourceAlias.Linux`. A NO-OP for
      per-address binding: an AnyIP local route (`ip -6 route add local
      <prefix> dev lo`) + `net.ipv6.ip_nonlocal_bind=1` make the WHOLE `/80`
      bindable without any per-address alias, so `ensure_source` / `release_source`
      do nothing. `arm_check` verifies both prerequisites.
    * **Disabled (`:docker` / anything without the prereqs)** —
      `Grappa.Net.SourceAlias.Disabled`. `arm_check` returns the concrete
      missing-prerequisite reason so mode 2 REFUSES TO ARM (Global Constraint:
      never fall through to a shared kernel-default source). `ensure_source` /
      `release_source` RAISE — they must never be reached while disarmed.

  ## Refuse-to-arm

  `arm_check/1` is the gate. The `Grappa.Net.SourceAliasManager` runs it once
  at boot (against the configured prefix) and publishes `armed?`; the session
  plan folds `armed?` into the addressing config so a disarmed mode-2 subject
  is HELD (`{:hold, :mode2_disarmed}`) rather than egressing from the wrong
  source. A `{:error, reason}` from `arm_check/1` is a hard "do not arm" — no
  partial arming, no best-effort.

  ## Prefix is threaded, never stored

  Every callback that touches an address takes the configured derivation
  prefix explicitly (there is ONE prefix — the DB `ServerSettings.static_mapping_prefix/0`
  the manager arms against; no env duplicate). `ensure_source/2` /
  `release_source/2` guard `IpLiteral.in_cidr6?/2` BEFORE shelling: refusing
  an address outside the block is the privilege-scope invariant the sudo
  wrapper enforces at the OS layer, checked here too so the process never even
  attempts an out-of-scope `ifconfig`.

  ## Boundary

  This module + its `Config` / `FreeBSD` / `Linux` / `Disabled` sub-modules
  form one boundary. The stateful ref-count lifecycle owner is the sibling
  boundary `Grappa.Net.SourceAliasManager` (it deps this one + `ServerSettings`).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Net.IpLiteral, Grappa.Sys.HardenedCmd],
    exports: [Config, FreeBSD, Linux, Disabled]

  @doc """
  Verify the substrate can actually bind an address inside `prefix`.

  `:ok` arms mode 2; `{:error, reason}` refuses to arm (the concrete
  missing-prerequisite reason, a closed atom set per adapter). MUST be
  side-effect-free beyond read-only probes.
  """
  @callback arm_check(prefix :: String.t()) :: :ok | {:error, reason :: atom()}

  @doc """
  Bind `addr` (a v6 literal strictly inside `prefix`) so the upstream socket
  can source from it. Idempotent at the OS layer where the substrate allows.
  Returns `{:error, :outside_prefix}` without shelling when `addr` is not in
  `prefix`.
  """
  @callback ensure_source(addr :: String.t(), prefix :: String.t()) :: :ok | {:error, term()}

  @doc """
  Remove the binding for `addr` (inside `prefix`). Returns `{:error,
  :outside_prefix}` without shelling when `addr` is not in `prefix`.
  """
  @callback release_source(addr :: String.t(), prefix :: String.t()) :: :ok | {:error, term()}

  @doc """
  List the addresses currently bound inside `prefix` at the OS layer — the
  ground truth the ref-count manager reconciles against at boot (release the
  orphans a crashed prior run left behind).
  """
  @callback list_aliases(prefix :: String.t()) :: {:ok, [String.t()]} | {:error, term()}
end
