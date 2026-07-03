// #171 — per-source-IP clone cap, end-to-end.
//
// The per-client concurrency cap was bypassable: visitor /
// unauthenticated logins carry `client_id: nil` (no X-Grappa-Client-Id
// header), so `Admission.check_client_cap/2` short-circuits to `:ok` and
// a single source IP could open arbitrary concurrent visitor sessions (7
// observed live on the running testnet). The fix adds a per-(source-IP,
// network) dimension reusing `max_per_client`, keyed on the persisted
// `accounts_sessions.ip`, applied to ALL flows including nil-client
// visitors. `:ip_cap_exceeded` maps to the SAME 503 `too_many_sessions`
// envelope as `:client_cap_exceeded` (cic unchanged — it keys on the
// wire string, not the atom).
//
// This spec drives the cap deterministically on `azzurra` (the anon
// visitor network — visitor logins are azzurra-only): mint the first
// visitor with headroom, then tighten `max_per_client` to 1 and prove a
// SECOND distinct nil-client visitor from the SAME runner IP is rejected
// with 503 `too_many_sessions`. `too_many_sessions` is emitted ONLY by
// the client/IP caps (the network-total cap is `network_busy`), and the
// second login carries no client_id, so the client cap cannot fire —
// the rejection can only be the IP cap. Asserting the wire status +
// envelope is the visible outcome, mirroring u-3's client-cap e2e.
//
// The runner is serial (`workers: 1`), so tightening azzurra for this
// spec cannot race another spec; the `finally` restores azzurra to the
// seeded headroom (100) so no later spec inherits a cap=1 on the shared
// runner IP.

import { expect, test } from "../fixtures/test";
import { ADMIN_IDENTIFIER, ADMIN_PASSWORD } from "../fixtures/seedData";
import {
  GRAPPA_BASE_URL,
  adminDeleteVisitor,
  login,
  mintVisitor,
} from "../fixtures/grappaApi";

// The anon visitor network. Its seeded `max_per_client` is the headroom
// value later specs rely on (see compose.yaml azzurra seeder).
const AZZURRA = "azzurra";
const AZZURRA_SEED_MAX_PER_CLIENT = 100;

async function adminPatchCaps(
  adminToken: string,
  slug: string,
  caps: Record<string, number | null>,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(caps),
  });
  if (!res.ok) {
    throw new Error(`adminPatchCaps: ${slug} → ${res.status} ${await res.text()}`);
  }
}

test("#171 — 2nd nil-client visitor from the same source IP is rejected 503 too_many_sessions", async () => {
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  const stamp = Date.now();
  const nickA = `ip171a${stamp}`;
  const nickB = `ip171b${stamp}`;
  let visitorAId: string | null = null;

  try {
    // Headroom first so the FIRST visitor is admitted regardless of any
    // leftover azzurra visitors from earlier specs on the shared IP.
    await adminPatchCaps(admin.token, AZZURRA, { max_per_client: AZZURRA_SEED_MAX_PER_CLIENT });
    const visitorA = await mintVisitor(nickA);
    visitorAId = visitorA.id;
    expect(visitorA.network_slug).toBe(AZZURRA);

    // Tighten the per-client knob to 1 → the per-(source-IP, network)
    // cap is 1. The runner IP now holds ≥1 live visitor (A).
    await adminPatchCaps(admin.token, AZZURRA, { max_per_client: 1 });

    // 2nd DISTINCT visitor, SAME runner IP, NO client-id header (the
    // nil-client bypass path). Pre-#171 this was admitted; now the IP
    // cap rejects it. Raw fetch (mintVisitor throws on non-2xx) so the
    // 503 surface can be asserted.
    const res = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: nickB }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too_many_sessions");
  } finally {
    if (visitorAId !== null) {
      await adminDeleteVisitor(admin.token, visitorAId).catch(() => {});
    }
    // Restore the seeded headroom so the serial runner's shared IP does
    // not throttle later specs' concurrent visitor logins.
    await adminPatchCaps(admin.token, AZZURRA, {
      max_per_client: AZZURRA_SEED_MAX_PER_CLIENT,
    }).catch(() => {});
  }
});
