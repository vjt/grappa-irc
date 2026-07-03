// U-2 — subject-aware admission split end-to-end.
//
// What U-2 ships at the admission layer (per
// docs/plans/2026-05-16-tmu-cluster-arc.md §UD1, UD3):
//   - `max_concurrent_visitor_sessions` + `max_concurrent_user_sessions`
//     are independent operator-tunable cap dimensions. A visitor cap
//     full does NOT block a user `/connect`, and vice versa.
//   - User-flow PATCH /networks/:slug {connection_state: "connected"}
//     consults the USER cap; on saturation returns 503 with
//     `{error: "network_busy"}` (FallbackController U-2 clause).
//
// Why REST-only (no browser UI):
// the cic-side U-2 change is purely additive copy arms in `Login.tsx`
// (3 typed timeouts → friendlyMessage), covered comprehensively by
// `cicchetto/src/__tests__/Login.test.tsx` vitest arms. The /connect
// PATCH error path through ComposeBox is a PRE-U-2 surface (network_busy
// has been the error code since T31); U-2 doesn't change cic's compose
// error rendering. The behavior that U-2 ADDS to the e2e-observable
// surface is the SERVER-SIDE admission decision matrix — two
// independent caps, two typed errors both wired to `network_busy`. We
// assert that decision matrix end-to-end through the e2e stack
// (nginx → grappa → admission → FallbackController) without driving the
// browser; per `feedback_ux_e2e_mandatory` the rule mandates Playwright
// e2e for cic UX-behavior changes, which U-2 does not have beyond what
// vitest already covers.
//
// Per `feedback_e2e_user_class_parity_matrix`: one parameterized spec
// over the (cap_dimension × expected_outcome) matrix rather than two
// near-identical specs.
//
// Pre-seeded state:
//   - vjt (user) bound to bahamut-test with `#bofh` autojoin (seedData).
//   - vjt's Session.Server is live at spec start (Bootstrap spawn +
//     autojoin completed during e2e harness boot).
//
// afterEach restores caps to permissive defaults so subsequent specs
// see the seeder baseline.

import { expect, test } from "../fixtures/test";
import {
  ADMIN_IDENTIFIER,
  ADMIN_PASSWORD,
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { login, patchNetworkConnectionState } from "../fixtures/grappaApi";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

type CapDimension = "max_concurrent_user_sessions" | "max_concurrent_visitor_sessions";

async function adminPatchCaps(
  adminToken: string,
  slug: string,
  caps: Partial<Record<CapDimension | "max_per_ip", number | null>>,
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

// PATCH /networks/:slug {connection_state: "connected"} returning the
// raw response so the matrix arm can assert status + body shape
// without grappaApi.ts's helper throwing on non-OK (which is the
// helper's contract for the success-only callers).
async function tryConnect(token: string, slug: string): Promise<Response> {
  return fetch(`${GRAPPA_BASE_URL}/networks/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ connection_state: "connected" }),
  });
}

// Restore vjt to :connected at afterEach in case the test left the
// credential :parked. Same pattern as cp15-b6-parked-disconnect-reconnect.spec.ts: best
// effort, fail open if already connected, then poll until #bofh shows
// up as joined so the next spec sees a healthy autojoin baseline.
async function restoreNetwork(token: string): Promise<void> {
  await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "connected" }).catch(
    () => {},
  );

  const channelsUrl = `${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(channelsUrl, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) {
      const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
      const bofh = channels.find((c) => c.name === SEED_CHANNEL);
      if (bofh?.joined) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 90s — body (~5s) + afterEach reconnect-and-autojoin poll (~30s) +
// safety margin for testnet load. Mirrors cp15-b6-parked.
test.setTimeout(90_000);

test.afterEach(async () => {
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  // Restore both caps to permissive (nil = unlimited) so subsequent
  // specs see the seeded baseline.
  await adminPatchCaps(admin.token, NETWORK_SLUG, {
    max_concurrent_user_sessions: null,
    max_concurrent_visitor_sessions: null,
  }).catch(() => {});

  const vjt = getSeededVjt();
  await restoreNetwork(vjt.token);
});

// Matrix arms:
//   1. user-cap=0    → /connect REJECTS with 503 network_busy
//   2. visitor-cap=0 → /connect SUCCEEDS (independent caps)
// Both arms exercise the same user-flow REST + admission path; the
// difference is only WHICH cap the admin saturates. A regression in
// the U-2 `subject_kind_for_flow` dispatch would flip either arm:
//   - If `:patch_network_connect` mistakenly resolved to `:visitor`,
//     arm 1 would PASS (user cap ignored) and arm 2 would FAIL
//     (visitor cap would now block the user path).
//   - If subject filtering in `count_live_sessions/2` broke, the live
//     user session count would leak into the visitor bucket (or vice
//     versa), flipping the arm boundary.
for (const arm of [
  {
    name: "user cap full → 503 network_busy",
    cap: "max_concurrent_user_sessions" as const,
    expectRejection: true,
  },
  {
    name: "visitor cap full → /connect succeeds (independent caps)",
    cap: "max_concurrent_visitor_sessions" as const,
    expectRejection: false,
  },
]) {
  test(`U-2 admission split — ${arm.name}`, async () => {
    const vjt = getSeededVjt();

    // Park first so /connect triggers a fresh spawn (admission gate
    // runs). connected→connected with cap=0 would NOT exercise the
    // gate because the session is already up; admission is checked
    // only at fresh-spawn time. Idempotent: prior specs may have
    // left vjt parked already → server returns 400 `not_parked` for
    // a re-park; treat that as success (the goal state is reached).
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, { connection_state: "parked" }).catch(
      (e: unknown) => {
        if (e instanceof Error && /not_connected|not_parked/.test(e.message)) return;
        throw e;
      },
    );

    // Admin saturates ONE cap dimension. cap=0 = degenerate lock-down;
    // any count >= 0 trips the rejection.
    const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
    await adminPatchCaps(admin.token, NETWORK_SLUG, { [arm.cap]: 0 });

    const res = await tryConnect(vjt.token, NETWORK_SLUG);

    if (arm.expectRejection) {
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("network_busy");
    } else {
      // 200 = SpawnOrchestrator approved + Networks.connect committed.
      // The independence invariant: a visitor cap of 0 must NOT block
      // a user-flow connect.
      expect(res.status).toBe(200);
    }
  });
}
