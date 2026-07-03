// #171 — per-source-IP clone cap, end-to-end.
//
// The ONLY per-actor admission cap is per-(source-IP, network). It
// replaced a per-client cap that visitor / unauthenticated logins
// bypassed by construction (they carry no X-Grappa-Client-Id), letting a
// single source IP open arbitrary concurrent visitor sessions (7 observed
// live). Keyed on the persisted `accounts_sessions.ip` against
// `max_per_ip`, applied to ALL flows. `:ip_cap_exceeded` maps to the 503
// `too_many_sessions` envelope (cic keys on the wire string, not the
// atom).
//
// This spec drives the cap deterministically on `azzurra` (the anon
// visitor network — visitor logins are azzurra-only): mint the first
// visitor with headroom, then tighten `max_per_ip` to 1 and prove a
// SECOND distinct visitor from the SAME runner IP is rejected with 503
// `too_many_sessions`. `too_many_sessions` is emitted ONLY by the per-IP
// cap (the network-total cap is `network_busy`), so a 503
// `too_many_sessions` here can only be the IP cap. Asserting the wire
// status + envelope is the visible outcome.
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

// The anon visitor network. Its seeded `max_per_ip` is the headroom
// value later specs rely on (see compose.yaml azzurra seeder).
const AZZURRA = "azzurra";
const AZZURRA_SEED_MAX_PER_IP = 100;

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
    await adminPatchCaps(admin.token, AZZURRA, { max_per_ip: AZZURRA_SEED_MAX_PER_IP });
    const visitorA = await mintVisitor(nickA);
    visitorAId = visitorA.id;
    expect(visitorA.network_slug).toBe(AZZURRA);

    // Tighten the knob to 1 → the per-(source-IP, network) cap is 1. The
    // runner IP now holds ≥1 live visitor (A).
    await adminPatchCaps(admin.token, AZZURRA, { max_per_ip: 1 });

    // 2nd DISTINCT visitor, SAME runner IP, NO client-id header (the path
    // the old per-client cap could not see). The per-IP cap rejects it.
    // Raw fetch (mintVisitor throws on non-2xx) so the 503 surface can be
    // asserted.
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
      max_per_ip: AZZURRA_SEED_MAX_PER_IP,
    }).catch(() => {});
  }
});
