# Per-client derived source addresses

**Audience:** IRC network operators and staff evaluating whether to let a grappa instance connect to their network.

> **Status: shipped and opt-in.** The derivation, the addressing mode that selects it, and the per-platform plumbing landed with [#543](https://github.com/vjt/grappa-irc/issues/543). It is **off by default** — an instance runs the pool mode unless an operator switches it on. Two limits are load-bearing enough to name up front, and both are stated in full below: the derivation is **flat**, so the ban ladder has two rungs and no intermediate aggregation; and the **blast-radius report** before a prefix-level ban is not implemented yet.

## The problem this solves

A bouncer is one process serving many people, so by default it is also **one source address** serving many people. That single fact breaks two things at once for the network it connects to:

1. **Your bans and throttles become collateral weapons.** Ban the address, and every user of that bouncer is gone, including the ones who did nothing. Throttle it — bahamut keys connection throttling on the address string — and one person's reconnect storm rate-limits everyone else behind it.
2. **The bouncer becomes a ban-evasion laundromat.** A user you already banned by address connects through the bouncer and arrives wearing an address you never banned. Nothing they did was subtle; the bouncer simply repainted them.

Both problems have the same root: the network cannot tell the bouncer's users apart at the layer where its existing tooling operates. Any fix that stays at the account layer (a per-client `ident`, for example) does not help, because throttling and clone limits key on the address, and an `ident` is a client-supplied string that a network has no reason to trust from a third party.

## The mechanism

The instance is given a routed IPv6 block — a **`/80`** — and **derives one address inside it per client network**, deterministically, from that client's own real source address:

```
derived = block_prefix (80 bits) || first 48 bits of SHA-256("grappa/source-mapping/v1" || client_key)

client_key = the client's /64   (IPv6 — interface id dropped)
             the client's /32   (IPv4 — the whole address)
```

The hash is **not keyed**. There is no secret and no key management: the mapping is client-prefix → our own block, not a privacy secret, so the only property that matters is a near-uniform spread over the host bits, and a plain SHA-256 gives that. The `"grappa/source-mapping/v1"` string is domain separation — a namespace label, so this derivation can never alias some other SHA-256 use over the same bytes — not a secret.

The interface id is deliberately ignored because RFC 8981 rotates it (privacy extensions) roughly daily; hashing the full 128 bits would silently expire every ban you set.

For a `/80` the host part is 48 bits, so by the birthday bound the first collision is expected around `2^24 ≈ 16.7M` distinct client prefixes. Real instances map thousands, not millions.

Two properties follow, and they are what the feature buys:

- **Stable.** The same client network always arrives as the same address, so a ban you set stays effective and a throttle key keeps counting the right person, across reconnects and across privacy-extension rotations.
- **Deterministic from the client's real address.** A user cannot shed their derived address without changing the address you would have banned anyway. That is the anti-evasion half: the bouncer stops laundering identity.

### The ban ladder is two rungs

| ban this | catches |
| --- | --- |
| the derived `/128` | one client network — one `/64` (IPv6) or one address (IPv4) |
| the whole `/80` | every derived session on the instance |

**There is nothing in between, and that is a real limitation.** The derivation is *flat*: the whole client key goes through one hash and lands anywhere in the 48 host bits, so two `/64`s inside the same customer `/48` — or the same upstream `/32` — produce two completely unrelated derived addresses. Aggregating a range of derived addresses catches nothing meaningful.

Two consequences, stated plainly:

- A client with a large delegation (`/56`, `/48`) can hop `/64`s and collect a fresh derived address per hop, and there is **no intermediate prefix that covers the delegation**. Against a determined evader with a routed `/48`, per-address bans are a treadmill; the only backstop is banning the `/80`, which is exactly as blunt as banning a bouncer is today.
- Conversely, the flat mapping leaks *less*: derived addresses that share high bits tell you nothing about the clients, because they share nothing but our block.

A hierarchical derivation — high bits from the client's upstream allocation, giving intermediate rungs — is possible and would change that first bullet. It is not what runs today. If the escalation ladder matters to your network, say so; do not plan around it existing.

## What it does not do, stated plainly

- **It is not a privacy or cloaking mechanism, and it is not sold as one.** Cloaking, if a network wants it, is the network's job and is applied on top.
- **Derived addresses have no PTR.** Reverse DNS is per-address and this space is combinatorial, so anything that expects forward-confirmed reverse DNS from a derived source will fail. Reserved, named addresses — the ones an instance grants to specific users — live outside the derived block, keep their PTR and their FCrDNS, and win over derivation. If your network requires FCrDNS, you get the reserved addresses, not the derived ones.
- **IPv4 behind CGNAT collapses, and that limit is real.** Thousands of subscribers sharing one carrier address hash to one derived address, so for those clients the collateral problem is reduced to the same granularity your own IPv4 bans already have — no worse than today, but no better either. This is intended: clients sharing an upstream vantage point share an egress.
- **The derived address is always IPv6, so this only applies to IPv6-reachable networks.** The connect path binds the derived source and then resolves the upstream in the *same* family; a network reachable only over IPv4 fails the bind with a source-family mismatch rather than silently falling back. An instance connecting to a v4-only network uses a different addressing mode.
- **The blast-radius report is not implemented.** We place a requirement on ourselves, worth stating because it protects your users too: any interface that offers a prefix-level ban has to report **how many live sessions the candidate prefix would hit** before it is set. Escalation power without a blast-radius number is a footgun for everyone. That interface does not exist yet. The ingredient does — every session that binds a derived source registers under it in a Registry, and `Session.live_derived_sources/0` returns the live set on a node as a pure ETS read — but the scan on top of it is still to be written.
- **It does not make the operator trustworthy.** It makes the operator's users *separable*, which is the part you can verify from the outside: ban one derived address, observe that exactly one client network loses its connection.

## Reservations, and what happens when derivation cannot run

Named addresses (vanity reverse DNS, per-user assignments) are granted explicitly and **win over derivation**. They live outside the derived block so that a derivation can never land on an address reserved for someone else — two users sharing an address is precisely the collateral this feature exists to remove. In this mode there is **no random pool**: a user either holds a reservation or arrives on their derived address. Nobody gets an address that was somebody else's yesterday.

An address pinned by the instance's admin for a specific network overrides everything, including derivation. That is an operator decision, visible to the operator, and it is the one way a session in this mode leaves the block.

When derivation *cannot* produce an address, the session is **held, not silently egressed from a shared source**. That is the load-bearing invariant of the whole feature, and it is enforced at every failure point:

| situation | outcome |
| --- | --- |
| the host cannot bind addresses in the block at all | session held (`mode2_disarmed`) |
| no block configured, or it is unparseable | session held (`no_static_prefix`) |
| the client's own address was never observed | session held (`no_client_source`) |

A held session is parked with its reason and reported as failed. It does not connect from the instance's default address, which would put an unseparated user on your network — the exact thing the feature exists to prevent.

## Operational cost, measured

Reference figures from a FreeBSD 14.3 host, 5000 concurrent derived addresses:

| measurement | result |
| --- | --- |
| configure 5000 addresses | ~30s total, cost per address linear in list length (2ms at 1k, 9ms at 5k) |
| add one more with 5000 present | 11ms |
| outbound `connect` latency with 5000 present | 5-6ms, indistinguishable from baseline |
| kernel memory for 5000 | ~4MB, fully reclaimed on removal |

These were measured against a larger block than the `/80` that shipped; they hold as orders of magnitude because **the size of the address *space* is not the cost — the number of *live sessions* is.**

- **Linux** needs no per-session work at all: an AnyIP local route makes the whole block locally deliverable and `net.ipv6.ip_nonlocal_bind=1` covers the outbound half, so binding a derived address is a no-op. Both prerequisites are probed at boot, and a host missing either refuses to arm rather than arming and failing every session.
- **FreeBSD** has no AnyIP equivalent — measured, including the non-local bind option, which fixes the bind and then leaves the return path broken — so each live derived address is configured as a `/128` alias on the loopback for the lifetime of the session, reference-counted across sessions sharing it, and reconciled against the interface at boot. The privilege boundary is a purpose-built wrapper that hard-codes the interface and the prefix length and refuses any address outside the configured block; it is not an unconstrained `sudo ifconfig`. At boot the wrapper is exercised for real — it adds and removes a canary inside the block — so a substrate that cannot actually alias (a non-VNET jail, a drifted prefix) refuses to arm with a concrete reason.

## What we ask of a network, and what we offer

We are not asking for an exemption. We are asking that the exemption you might otherwise have to grant a bouncer — "please do not ban this address, there are innocents behind it" — becomes unnecessary, because you can ban the guilty client and only the guilty client.

In return we expect to be held to it: if a derived address misbehaves, ban it and it stays banned; if what this document describes is not what you observe, that is a bug and we want the report.
