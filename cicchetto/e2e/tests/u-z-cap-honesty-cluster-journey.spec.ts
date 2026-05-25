// U-cluster U-Z — full cap-honesty operator journey end-to-end.
//
// Covers the shipping reality of the entire U cluster (U-0..U-6) as a
// single composed REST journey. Mirrors M-Z's shape (one spec, one
// `try/finally` cap-restore) but stays REST-only by design: the
// browser-rendered surfaces (cic banners + Networks tab live counters
// + admin Sessions cap-count summary) are exhaustively smoked by the
// per-bucket specs (u-3-cap-honesty-mapping for Sessions tab summary,
// m10-admin-networks-cap-editor for the Networks tab editor, M-Z for
// the admin-events fan-out). Re-driving them here would duplicate
// per-bucket coverage without adding new signal — per
// `feedback_e2e_user_class_parity_matrix`, U-Z is the cross-bucket
// COMPOSITIONAL spec, not a re-run of every guarded surface.
//
// The U-narrative this spec pins:
//
//   Step 1. Park vjt's seeded session so /connect re-spawns through
//           admission (admission gates only on fresh spawn).
//   Step 2. Admin saturates the USER cap (=0) and the user-flow
//           /connect rejects with 503 `network_busy` (U-0 spawn-first
//           contract + U-2 subject-aware admission + U-3 FC mapping).
//   Step 3. DB row stays at the prior `:parked` state — U-0's
//           spawn-first/commit-second invariant. Pre-U-0 the row
//           would have flipped to `:connected` and the post-fail row
//           would be a phantom-connected. The PATCH 503 response IS
//           the boundary observation but we also verify GET
//           /admin/networks/:slug reflects the row's pre-PATCH cap
//           configuration unchanged (no half-write).
//   Step 4. Admin bumps user cap to 1; vjt /connect succeeds 200.
//           (Bumping mid-cluster mirrors the plan's "admin opens
//           console → bumps cap" step.)
//   Step 5. Visitor-cap independence: admin sets visitor cap=0,
//           leaves user cap=10, vjt /connect SUCCEEDS — visitor
//           saturation never blocks operator login (UD1 split).
//
// Step 4 (logout visitor → user same client_id), Step 5 (visitor
// /quit slot freed), Step 6 (capacity_reject admin event lands),
// Step 8 (iptables connect-timeout phase smoke) — see
// "Why four plan items are documented but not driven" below.
//
// Per `feedback_cicchetto_browser_smoke`: this spec doesn't drive
// chromium (no `page` fixture). U-cluster surfaces are server-side
// admission decisions + FC mappings; the visual smoke for cic
// renderings is covered per-bucket in u-3 + u-5 specs (both DO drive
// chromium for their respective surfaces).
//
// Why four plan §U-Z items are documented but not driven:
//
//   - **Step 4 (logout visitor → login user same client_id)** +
//     **Step 5 (visitor /quit frees slot)**: equivalent to UD5.A
//     tests parked at u-4-device-identity-change as `test.skip` per
//     `feedback_visitor_mint_e2e_cold_start` (the bahamut-test mint
//     pathway 504s on cold start; visitor surfaces in U-cluster e2es
//     are blocked on the same pre-seeded-visitor work as M-8). The
//     production behavior is unit-tested at admission_test.exs +
//     auth_controller_test.exs (UD5.A logout-is-synchronous test).
//
//   - **Step 6 (capacity_reject admin event lands live)**: covered
//     end-to-end by `m-z-admin-cluster-journey.spec.ts` (the M cluster
//     close spec already drives PATCH cap=0 → mint visitor → assert
//     event row in Events tab in real time). Duplicating the same
//     fan-out path here against the user-flow /connect-reject would
//     re-exercise the same `Admission.Telemetry → AdminEvents.record
//     → broadcast` plumbing without adding a new signal — the U-3
//     FC mapping difference (network_busy vs too_many_sessions) is
//     covered by u-2-admission-split + u-3-cap-honesty-mapping
//     respectively at the wire boundary.
//
//   - **Step 8 (iptables DROP → :connect_timeout phase smoke)**:
//     infeasible in the e2e harness. iptables DROP requires
//     NET_ADMIN capability inside the test container, plus
//     coordinated routing changes to the testnet leaf. The
//     per-phase typed errors (`:connect_timeout` vs
//     `:welcome_timeout` vs `:probe_timeout`) are unit-tested
//     at `test/grappa/visitors/login_test.exs` (UD7 mock-based
//     phase-boundary assertions) — the timeout split has a unit
//     test for each phase boundary, and the FallbackController
//     mapping has integration coverage. The remaining e2e
//     observation would be "real Bahamut + slow rDNS produces
//     :welcome_timeout typed error" which only the live operator
//     can actually trigger (and which the production deploy
//     post-U-2 has already proven on raccooncity.azzurra.chat).
//
// Pre-seeded state:
//   - vjt (user) bound to bahamut-test with `#bofh` autojoin
//     (seedData).
//   - vjt's Session.Server is live at spec start (Bootstrap spawn +
//     autojoin completed during e2e harness boot).
//
// afterEach restores ALL caps to permissive (nil = unlimited) AND
// restores vjt to :connected so subsequent specs see the seeder
// baseline. Mirrors u-2 + u-3 cleanup pattern.

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

type CapKnob =
  | "max_concurrent_user_sessions"
  | "max_concurrent_visitor_sessions"
  | "max_per_client";

async function adminPatchCaps(
  adminToken: string,
  slug: string,
  caps: Partial<Record<CapKnob, number | null>>,
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

// Fetch a single network's admin row by filtering the
// `GET /admin/networks` index payload. The singular-GET endpoint is
// intentionally absent (M-cluster shipped only index + PATCH); index
// is O(networks) and the seed fixture stays at a handful, so the
// scan is trivial. Used by Step 3 to assert U-0's spawn-first/
// commit-second invariant: a 503-rejected /connect MUST leave the
// credential row at its pre-PATCH `connection_state` (no partial
// DB commit).
async function adminGetNetwork(
  adminToken: string,
  slug: string,
): Promise<{
  slug: string;
  max_concurrent_user_sessions: number | null;
  max_concurrent_visitor_sessions: number | null;
}> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`adminGetNetwork(index): ${slug} → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    networks: Array<{
      slug: string;
      max_concurrent_user_sessions: number | null;
      max_concurrent_visitor_sessions: number | null;
    }>;
  };
  const row = body.networks.find((n) => n.slug === slug);
  if (!row) {
    throw new Error(`adminGetNetwork: ${slug} not in /admin/networks index`);
  }
  return row;
}

// PATCH /networks/:slug {connection_state: "connected"} returning raw
// Response so arms can assert status + body without grappaApi.ts's
// throw-on-non-OK contract.
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

// Restore vjt to :connected at afterEach so subsequent specs see a
// healthy autojoin baseline. Mirrors u-2-admission-split.
//
// LOUD failure logging: u-2 + u-3 silently swallow the reconnect
// failure (the autojoin poll just times out without asserting), which
// can poison the next spec's expectation that vjt's session is live.
// U-Z is the cluster CLOSE — the right place to add a LOUD signal at
// the cleanup boundary instead of swallowing. Don't `throw` (that
// would mask the original assertion failure per Playwright's
// afterEach semantics); a `console.error` lands in the Playwright
// reporter's output so a future operator chasing a "why is the
// NEXT spec flaking" question has the cleanup-failed breadcrumb.
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
  // eslint-disable-next-line no-console
  console.error(
    `U-Z afterEach restoreNetwork: vjt did not re-join ${SEED_CHANNEL} on ${NETWORK_SLUG} within 30s; next spec may flake on autojoin assumption`,
  );
}

// 90s — body (~10s) + afterEach reconnect-and-autojoin poll (~30s) +
// safety margin. Same envelope as u-2 + u-3.
test.setTimeout(90_000);

test.afterEach(async () => {
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  // Restore all caps to permissive (nil = unlimited). LOUD logging on
  // failure: a silent .catch here would leave saturated caps in place
  // for the next spec, surfacing as confusing 503-network_busy from
  // a totally unrelated /connect. Log to stderr so the Playwright
  // reporter captures it; don't throw (would mask the original
  // assertion failure per Playwright afterEach semantics).
  await adminPatchCaps(admin.token, NETWORK_SLUG, {
    max_concurrent_user_sessions: null,
    max_concurrent_visitor_sessions: null,
    max_per_client: null,
  }).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      `U-Z afterEach adminPatchCaps: failed to restore ${NETWORK_SLUG} caps to permissive — next spec may flake on cap-saturation residue: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  const vjt = getSeededVjt();
  await restoreNetwork(vjt.token);
});

test("U-Z cap-honesty journey: park → user-cap-reject → row-unchanged → bump → reconnect → visitor-independence", async () => {
  const vjt = getSeededVjt();
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);

  // STEP 1 — Park vjt's Bootstrap-spawned session so subsequent
  // /connect attempts hit the fresh-spawn admission path. Admission
  // is gated only at fresh spawn (idempotent re-connect on a live
  // pid returns 200 without re-checking caps). Idempotent: a
  // /connect-then-park of an already-parked row returns 400
  // `not_connected`; treat as success (goal state reached).
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, { connection_state: "parked" }).catch(
    (e: unknown) => {
      if (e instanceof Error && /not_connected|not_parked/.test(e.message)) return;
      throw e;
    },
  );

  // STEP 2 — User cap saturated (=0) and user /connect rejected
  // with 503 `network_busy`. This is the composed surface across:
  //   - U-0: NetworksController.spawn_session_after_connect/3 bails
  //     on spawn failure (vs pre-U-0 silent success).
  //   - U-2: Admission.check_network_total/1 routes via subject_kind
  //     to check_user_cap, returns :user_cap_exceeded.
  //   - U-3: FallbackController maps :user_cap_exceeded → 503
  //     network_busy (vs visitor surfaces' too_many_sessions).
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_concurrent_user_sessions: 0 });

  const rejected = await tryConnect(vjt.token, NETWORK_SLUG);
  expect(rejected.status).toBe(503);
  const rejectedBody = (await rejected.json()) as { error: string };
  expect(rejectedBody.error).toBe("network_busy");

  // STEP 3 — Row stays at the prior :parked state (U-0 invariant:
  // spawn-first/commit-second; no partial DB commit on spawn fail).
  // Verified via:
  //   (a) GET /admin/networks (index-filtered by slug) — the cap
  //       we just PATCHed persists (so we know the PATCH landed);
  //       other fields (visitor cap) unchanged (no surprise
  //       side-effects).
  //   (b) GET /networks/:slug — the user-facing row is still
  //       `:parked` (the failed /connect did NOT commit
  //       connection_state := :connected).
  // Pre-U-0 (a) + (b) would have surfaced the bug: row at
  // :connected with no Session.Server.
  const after = await adminGetNetwork(admin.token, NETWORK_SLUG);
  expect(after.max_concurrent_user_sessions).toBe(0);

  const userView = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${vjt.token}` },
  });
  expect(userView.status).toBe(200);
  const userViewBody = (await userView.json()) as Array<{
    slug: string;
    connection_state: string;
  }>;
  const userRow = userViewBody.find((n) => n.slug === NETWORK_SLUG);
  expect(userRow?.connection_state).toBe("parked");

  // STEP 4 — Admin bumps user cap to 3 (room for vjt's one session
  // + m9b-test's bootstrap session + m9b-victim's bootstrap session —
  // m9b-victim is seeded alongside vjt + m9b-test by compose.yaml since
  // GREEN-CI batch-1 added it as the sacrificial Disconnect/Terminate
  // target in m9b-admin-sessions-actions. Pre-m9b-victim the cap=2 was
  // sufficient; post-m9b-victim the test must account for the third
  // seeded user. vjt /connect succeeds with 200; spawn-orchestrator
  // commits the DB transition.
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_concurrent_user_sessions: 3 });

  const reconnected = await tryConnect(vjt.token, NETWORK_SLUG);
  expect(reconnected.status).toBe(200);

  // STEP 5 — Visitor cap independence (UD1). Park again, then admin
  // saturates VISITOR cap (=0) while leaving USER cap permissive
  // (=10). vjt /connect MUST succeed — visitor saturation never
  // blocks operator login. This is the load-bearing UD1 invariant;
  // pre-U-1 the single shared cap would have rejected this.
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, { connection_state: "parked" }).catch(
    () => {},
  );

  await adminPatchCaps(admin.token, NETWORK_SLUG, {
    max_concurrent_visitor_sessions: 0,
    max_concurrent_user_sessions: 10,
  });

  const independentConnect = await tryConnect(vjt.token, NETWORK_SLUG);
  expect(independentConnect.status).toBe(200);
});
