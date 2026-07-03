// U-3 — cap honesty + friendly mapping end-to-end.
//
// What U-3 ships at the e2e-observable surface (per
// docs/plans/2026-05-16-tmu-cluster-arc.md §U-3 + UD3 + UD4):
//
//   - UD3: FallbackController's `:client_cap_exceeded` clause flipped
//     from 429 → 503 with envelope `too_many_sessions` (distinct from
//     `network_busy` so cic can render device-scoped vs network-scoped
//     copy via friendlyApiError). The 503-vs-429 status flip is the
//     wire-contract change.
//
//   - UD4: `GET /admin/networks` composes a `live_counts:` projection
//     per row (`%{visitors: N, users: M}`) reusing the same Registry
//     match-spec the admission policy consults — so the operator
//     console cannot misreport capacity vs. policy. The cic
//     AdminSessionsTab renders a per-network cap-count summary block
//     above the sessions table.
//
// Per `feedback_e2e_user_class_parity_matrix`: ONE parameterized spec
// over the (server-side wire contract + browser-rendered surface)
// axes. The user-class parity matrix doesn't apply here: U-3's
// production surfaces are FallbackController (server) + admin
// console (admin-gated EXEMPT). The compose-box friendly-copy
// integration is exhaustively covered at unit-level by
// `friendlyApiError.test.ts` (19+ cases) + `Login.test.tsx` arms.
//
// Why two narrow assertions instead of three:
//   - The 503-too_many_sessions wire flip MUST be exercised end-to-end
//     (status 503 + envelope `too_many_sessions`) — the FC clause
//     change is observable only at the HTTP boundary.
//   - The admin Sessions tab summary block MUST render in chromium —
//     vitest jsdom can't observe CSS layout (per
//     `feedback_cicchetto_browser_smoke`).
//   - The visitor-cap 503-network_busy path is already pinned by
//     u-2-admission-split.spec.ts — re-asserting here would be the
//     duplication the parity-matrix rule explicitly rejects.
//
// Pre-seeded state:
//   - vjt (user) bound to bahamut-test w/ `#bofh` autojoin.
//   - admin-vjt is_admin=true; reaches admin console.
//
// afterEach restores caps to permissive defaults.

import { expect, test } from "../fixtures/test";
import {
  ADMIN_IDENTIFIER,
  ADMIN_PASSWORD,
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  M9B_USER,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { login, patchNetworkConnectionState } from "../fixtures/grappaApi";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

type CapKnob =
  | "max_concurrent_user_sessions"
  | "max_concurrent_visitor_sessions"
  | "max_per_ip";

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

// /connect a network via the user-flow REST surface — returns the raw
// Response so the arm can assert status + body shape without the
// throw-on-non-OK contract of grappaApi.patchNetworkConnectionState.
//
// Forces a fixed client_id so the per-test client population stays
// disjoint from the seeded vjt's stable browser client_id (which the
// vitest harness doesn't share). Without this the test would
// false-pass: vjt's prior REST + WS calls under a different client_id
// wouldn't count toward the per-client cap.
async function connectWithClientId(
  token: string,
  slug: string,
  clientId: string,
): Promise<Response> {
  return fetch(`${GRAPPA_BASE_URL}/networks/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-grappa-client-id": clientId,
    },
    body: JSON.stringify({ connection_state: "connected" }),
  });
}

// Login surface that takes a deterministic client_id so the
// resulting accounts_session row's `client_id` column matches the
// caller's expectation. Returns the bearer.
async function loginWithClientId(
  identifier: string,
  password: string,
  clientId: string,
): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-grappa-client-id": clientId,
    },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) {
    throw new Error(`loginWithClientId: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// Restore vjt to :connected post-arm so subsequent specs see a
// healthy baseline (autojoin completed). Mirrors u-2-admission-split.
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

test.setTimeout(90_000);

test.afterEach(async () => {
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  await adminPatchCaps(admin.token, NETWORK_SLUG, {
    max_concurrent_user_sessions: null,
    max_concurrent_visitor_sessions: null,
    max_per_ip: null,
  }).catch(() => {});

  const vjt = getSeededVjt();
  await restoreNetwork(vjt.token);
});

// Arm 1: UD3 — client cap saturation → 503 too_many_sessions.
//
// UX-5 bucket BC (2026-05-19) re-frame: pre-BC this arm exercised
// self-saturation (same user holding 1 session against cap=1, second
// /connect by the same user → 503). That assertion pinned a bug:
// the cap counted the requesting subject's own pre-existing session
// against itself, which made T32 park → /connect always 503 at the
// default `max_per_ip = 1`. Per CLAUDE.md "Never assert buggy
// behavior," the assertion was migrated to the genuine cap-saturation
// case: a SECOND distinct user on the SAME device. m9b-test (seeded
// alongside vjt in compose.yaml) provides the cross-subject fixture.
//
// What's still asserted end-to-end at the HTTP boundary:
//   - admin-set `max_per_ip = 1` saturates when 2 distinct users
//     each hold 1 accounts_session on the SAME client_id;
//   - FallbackController U-3 clause maps `:client_cap_exceeded` →
//     503 envelope `too_many_sessions` (status flip from pre-U-3's
//     429, the U-3 wire-contract change being regression-guarded).
//
// What is NO LONGER asserted (correctly): a user can never be cap-
// blocked by its OWN pre-existing session. Covered server-side by
// the UX-5 BC unit + controller tests, and at the e2e by
// `ux-5-bc-park-respawn.spec.ts`.
test("U-3 — per-IP cap saturation → 503 too_many_sessions", async () => {
  const vjt = getSeededVjt();

  // Park vjt's Bootstrap-spawned session so the /connect re-spawn
  // path is the one under test (admission is gated only at fresh
  // spawn time). Idempotent.
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, { connection_state: "parked" }).catch(
    (e: unknown) => {
      if (e instanceof Error && /not_connected|not_parked/.test(e.message)) return;
      throw e;
    },
  );

  // #171: the per-IP cap ignores client_id, but the login/connect
  // helpers still send a valid one (canonical UUID v4 — `ClientId.regex/0`
  // rejects anything else at the `Plugs.ClientId` boundary). Harmless
  // here; kept so the helpers stay reusable across specs.
  const clientId = "a3000000-0000-4000-8000-000000000033";

  // Bump max_per_ip UP first so the setup connects have headroom before
  // the mid-test drop to 1. The dev/e2e default is 10 (config/dev.exs);
  // making it explicit keeps the spec independent of that default and of
  // however many other users already hold a session on the shared IP.
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_ip: 10 });

  // vjt logs in under the fixed client_id → creates
  // accounts_session(vjt, client_id). /connect succeeds at cap=10.
  const vjtBearer = await loginWithClientId(vjt.identifier, vjt.password, clientId);
  const vjtConnect = await connectWithClientId(vjtBearer, NETWORK_SLUG, clientId);
  expect(vjtConnect.status).toBe(200);

  // Admin drops max_per_ip to 1 — vjt's session occupies the slot.
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_ip: 1 });

  // m9b-test (a DIFFERENT user with a credential for the SAME network,
  // /connecting from the SAME source IP) tries /connect. The per-IP cap
  // counts vjt's session (different subject, NOT self-excluded) →
  // count=1, cap=1 → :ip_cap_exceeded → 503 too_many_sessions. This is
  // the genuine cross-subject saturation the cap exists to enforce.
  const m9bIdentifier = `${M9B_USER}@grappa.test`;
  const m9bBearer = await loginWithClientId(m9bIdentifier, "test-password-not-secret", clientId);

  // Park m9b's Bootstrap session first so /connect goes through the
  // fresh-spawn admission path (idempotent re-connect of a live pid
  // would 200 without re-checking caps).
  await patchNetworkConnectionState(m9bBearer, NETWORK_SLUG, { connection_state: "parked" }).catch(
    () => {},
  );

  const m9bConnect = await connectWithClientId(m9bBearer, NETWORK_SLUG, clientId);
  expect(m9bConnect.status).toBe(503);
  const body = (await m9bConnect.json()) as { error: string };
  expect(body.error).toBe("too_many_sessions");

  // Restore m9b's session so subsequent specs see a healthy baseline.
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_ip: null });
  await patchNetworkConnectionState(m9bBearer, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});
});

// Arm 2: UD4 — admin Sessions tab renders per-network cap-count
// summary block in chromium. Vitest covers the unit assertions
// (4 cases); this browser smoke catches CSS-layout / SolidJS
// reactivity regressions vitest jsdom is blind to (per
// `feedback_cicchetto_browser_smoke`).
test("U-3 (UD4) — admin Sessions tab renders per-network cap-count summary", async ({ page }) => {
  const seed = getSeededAdmin();

  // Inject admin bearer + subject + install choice so the cic shell
  // boots straight into the authenticated surface, then drive the
  // browser into the Sessions tab via the same flow the operator
  // uses (settings → admin console entry → Sessions sub-tab).
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();

  // Sessions is the default tab on M-9b (no click needed), but the
  // explicit click below mirrors the operator flow exactly + future-
  // proofs against a default-tab reshuffle.
  await page.getByTestId("admin-tab-sessions").click();

  // The summary block is rendered only when `/admin/networks`
  // returns at least one row. Seeder fixture binds two networks
  // (`bahamut-test`, `azzurra`), so the block must be present.
  const summary = page.getByTestId("admin-sessions-network-summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });

  // Per-row presence: bahamut-test row + cells.
  const slug = NETWORK_SLUG;
  await expect(page.getByTestId(`admin-sessions-summary-row-${slug}`)).toBeVisible();

  // Cell text shape: "N/cap" — N is a non-negative integer, cap is
  // a non-negative integer OR ∞. Assert the regex, not exact
  // values (the operator-set caps on the seeder default can drift
  // across seeder edits).
  const visitorsCell = await page
    .getByTestId(`admin-sessions-summary-visitors-${slug}`)
    .textContent();
  expect(visitorsCell).toMatch(/^\d+\/(\d+|∞)$/);

  const usersCell = await page.getByTestId(`admin-sessions-summary-users-${slug}`).textContent();
  expect(usersCell).toMatch(/^\d+\/(\d+|∞)$/);

  const perIpCell = await page
    .getByTestId(`admin-sessions-summary-per-ip-${slug}`)
    .textContent();
  expect(perIpCell).toMatch(/^(\d+|∞)$/);
});
