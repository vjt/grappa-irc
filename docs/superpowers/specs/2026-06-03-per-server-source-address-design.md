---
title: Per-server outbound source address + visitor-pool exclusion
date: 2026-06-03
status: approved (pending implementation)
author: vjt + Claude
supersedes: none
---

# Per-server outbound source address

## Problem

Grappa binds every outbound IRC connection's source IP from a single
shared pool (`Grappa.OutboundV6Pool`, IPv6-only, `GRAPPA_OUTBOUND_V6_POOL`
env CSV, real socket `ifaddr` bind in `lib/grappa/irc/client.ex:748`
`do_connect/3` via `resolve_and_ifaddr/1`). The pool is rolled fresh per
connect and is shared by **all** sessions — users and visitors alike.
There is no IPv4 source path and no way to pin a connection to a fixed
source address.

vjt needs to run his own user (`vjt`) on Azzurra via a specific server
(`raccooncity`) from a **fixed, dedicated** source IP (the literal IP of
`m42.openssl.it`) so his host-restricted **O-line** matches. Visitors
must keep the existing rotating-pool semantics, and must **never** bind
the dedicated oper IP.

This is a precondition for vjt replacing his current IRC client with
cicchetto.

## Goals

- A server (`network_servers` row) can carry a **fixed literal source
  IP** (v4 or v6). When set, connections to that server bind it as the
  outbound source; the pool is bypassed.
- Add the **IPv4 source-bind path** (today only v6 is bindable).
- The visitor pool **automatically excludes** every configured fixed
  source IP, by construction — a visitor cannot be handed a dedicated
  IP.
- Deterministic: a fixed-source server uses the same IP on every
  connect/retry (O-line host stability).

## Non-goals (YAGNI)

- **No WEBIRC.** Grappa binds real sockets; it does not present a
  spoofed client IP to upstream.
- **No per-visitor dedicated IPs.** The pool remains the visitor model.
- **No hostname sources.** Operator supplies a literal IP (resolves
  `m42.openssl.it` themselves). Rationale: literal IP makes the pool
  subtraction a static set difference and the bind family unambiguous.
- **No IPv4 *pool*.** The visitor pool stays IPv6-only. Only the *fixed
  source* gains a v4 path.
- **No per-network "all servers same source" constraint.** Source is
  purely per-server and independent (dropped during review).
- **No per-network type column / visitor-admission guard.** The split
  between a user-dedicated network and the visitor network is by
  configuration (which network row the visitor-provisioning flow
  targets), not enforced in code (dropped during review).
- **No per-user server override inside a shared network.** Per-user
  networks are separate `networks` rows (current model already
  supports this).

## Decisions (settled during brainstorming)

1. **Source lives per-server** (`network_servers.source_address`), not
   per-credential or per-network. Matches "specify in the server
   configuration"; lets failover servers differ.
2. **Literal IP only** (v4 or v6). Hostnames/CIDR rejected at the
   changeset boundary.
3. **Emergent split, no enforcement.** A network is "dedicated" simply
   because its server(s) have a `source_address`; "visitor" because they
   don't. No new column, no admission guard.
4. **Exclusion is subtract-not-assert.** Overlap between a fixed source
   and the pool does **not** refuse to boot (that invariant can't be
   forced on every operator). Instead Bootstrap subtracts fixed sources
   from the effective visitor pool. Safe by construction, never fatal,
   no-op when no fixed sources exist.

## Design

### 1. Data model

Add a nullable column to `network_servers`:

```
add :source_address, :string, null: true   # literal IPv4 or IPv6, or NULL
```

- `NULL` → existing pool path (visitor semantics), unchanged.
- non-`NULL` → bind this literal IP as the outbound source for
  connections to this server.

`Grappa.Networks.Server` changeset (`lib/grappa/networks/server.ex`)
validates `source_address` when present: it MUST parse via
`:inet.parse_ipv4strict_address/1` **or** `:inet.parse_ipv6strict_address/1`.
Reject hostnames, CIDR, empty string. Store the canonical string form.
No cross-server / per-network constraint.

New migration `priv/repo/migrations/<ts>_add_source_address_to_servers.exs`
— plain `alter table(:network_servers) do add :source_address ... end`.

### 2. Connection path (the bind)

`lib/grappa/irc/client.ex` `do_connect/3` (currently `(host, port, tls)`)
gains the picked server's `source_address`. Add a sibling to
`resolve_and_ifaddr/1` used when a fixed source is present:

```
fixed source present:
  fam     = family of the literal source (:inet for v4, :inet6 for v6)
  records = resolve upstream `host` for `fam` only
            (A records for :inet, AAAA for :inet6)
  if records == []  -> FAIL the connect with a clear, logged error
                       (e.g. {:error, {:source_family_mismatch, source, host, fam}});
                       a v4 source against a v6-only server is a misconfig — surface it
  else              -> opts = [ifaddr: source_ip_tuple], connect over `fam`
```

Apply `ifaddr` + `fam` in **both** branches of `do_connect`
(`:gen_tcp.connect` and `:ssl.connect`). When `source_address` is
`NULL`, take the existing `resolve_and_ifaddr/1` (v6 pool or kernel
default) path verbatim.

Fixed source is deterministic — every connect and every retry to that
server uses the same literal IP (contrast the pool, which rolls per
connect). This is required for O-line host stability.

**Threading:** `source_address` is a field on the `%Server{}` struct, so
it is available wherever the server is already picked
(`Grappa.Networks.Servers.pick_server!/1`). Trace the existing
`host/port/tls` flow from the picked server → session start opts →
`IRC.Client` connect and carry `source_address` alongside. Touch points
to verify during implementation: `lib/grappa/networks/session_plan.ex`
and `lib/grappa/visitors/session_plan.ex` (plan construction),
`Grappa.Session.Server` (start opts → connect), `IRC.Client` connect
entry. No new control flow — one extra value on an existing path.

### 3. Visitor-pool exclusion (subtract, never assert)

`Grappa.OutboundV6Pool` keeps the raw env-derived list (built today at
`lib/grappa/application.ex:58` via `boot/0`). Add the ability to install
an **effective** pool = `raw − exclusions`:

- New function, e.g. `OutboundV6Pool.apply_exclusions(exclusion_ips)`:
  recompute `effective = raw_pool -- normalize(exclusion_ips)` and write
  it to the `:persistent_term` key that `pick/0` reads. Keep the raw
  list separately so the operation is idempotent (re-running with the
  same/expanded exclusions is safe).
- Normalize both sides to `:inet` IP tuples before the set difference so
  string-format differences (`::1` vs `0:0:..:1`) don't leak a dedicated
  IP back into the pool. v4 exclusions against the v6 pool are a no-op
  (disjoint by family) — correct and harmless.

`Grappa.Bootstrap` (the **last** supervised child — Repo is up), **before
it spawns any sessions**:

1. `Repo.all(from s in Server, where: not is_nil(s.source_address),
   select: s.source_address)`.
2. `OutboundV6Pool.apply_exclusions(those)`.
3. Log honestly: `outbound pool: N configured, M excluded as fixed
   sources [list], K effective`. If a fixed source was actually present
   in the raw pool, that's the line that makes the subtraction
   observable (per CLAUDE.md log-honesty).

Two-phase ordering guarantees safety: `Application.start` installs the
raw env pool as today; Bootstrap refines it to the effective pool
**before** spawning, so no visitor session ever `pick/0`s from the
pre-exclusion pool.

### 4. Caveat recorded by design

Because the bind is **per-server**, *any* session that lands on a
source_address'd server binds that IP — there is no subject-level
(visitor vs user) gate (the visitor-admission guard was considered and
dropped during review as unnecessary complexity). Keeping visitors off
dedicated networks is the **operator's configuration responsibility**:
the visitor-provisioning flow must target a
pool-source network, not a dedicated one. §3 still protects the *pool*
(a rotating visitor on a pool-source network can never draw a dedicated
IP); it does not protect against an operator deliberately pointing
visitor provisioning at a dedicated network. That is an accepted,
documented limitation, not a bug.

### 5. Config surface

- `mix grappa.bind_network --source <ip>` — set the server's source at
  bind time.
- `mix grappa.add_server --source <ip>` — for failover servers on a
  dedicated network.
- Both: validate `<ip>` parses as a strict literal IPv4/IPv6 (reuse the
  Server changeset validation, don't re-implement). No all-or-nothing
  check, no hard not-in-pool rejection (subtraction handles overlap).
  An optional **notice** if `--source` is also present in
  `GRAPPA_OUTBOUND_V6_POOL` ("will be excluded from the visitor pool")
  is informative, not an error.
- vjt's target setup: one `azzurra` network bound to `vjt`, server
  `raccooncity` with `--source <m42-literal-ip>`; a separate visitor
  network with pool-source (no `--source`) servers.

### 6. Testing

- **Source bind unit** (`Grappa.IRCServer` fake): v4 source binds inet +
  v4 ifaddr; v6 source binds inet6 + v6 ifaddr; source-family vs
  upstream-only-other-family → clear error (no silent fallback).
- **Server changeset:** accepts strict v4 and v6 literals; rejects
  hostname, CIDR, empty, garbage.
- **Pool subtraction:** `apply_exclusions/1` yields `effective = raw −
  fixed`; v4 exclusion against v6 pool is a no-op; an exclusion equal to
  a pool member (string-format variant) is actually removed;
  `pick/0` never returns an excluded IP. Bootstrap log line asserted.
- **Threading:** a session for a fixed-source server connects with the
  literal source (assert via the fake server's observed peer / the
  connect opts), and a NULL-source server still uses the pool path.
- Zero warnings (`mix test --warnings-as-errors`). Property test for the
  IP-literal validation boundary if it earns it.

## Files (implementation touch-list)

- `priv/repo/migrations/<ts>_add_source_address_to_servers.exs` (new)
- `lib/grappa/networks/server.ex` (schema field + changeset validation)
- `lib/grappa/irc/client.ex` (`do_connect/3` source bind + v4 path +
  family-mismatch error)
- `lib/grappa/outbound_v6_pool.ex` (`apply_exclusions/1`, raw vs
  effective)
- `lib/grappa/bootstrap.ex` (gather sources → apply_exclusions → log,
  before spawn)
- `lib/grappa/networks/session_plan.ex`, `lib/grappa/visitors/session_plan.ex`,
  `Grappa.Session.Server`, connect entry (thread `source_address`)
- `lib/mix/tasks/grappa.bind_network.ex`, `lib/mix/tasks/grappa.add_server.ex`
  (`--source` option + validation)
- Tests mirroring §6
- `docs/DESIGN_NOTES.md` entry on landing; `README.md` server-config
  section if it enumerates server fields.

## Open questions

None blocking. During implementation, confirm the exact connect-entry
signature when threading `source_address` (one extra value on an
existing path).
