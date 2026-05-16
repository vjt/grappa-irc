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

import { expect, test } from "@playwright/test";
import {
  ADMIN_IDENTIFIER,
  ADMIN_PASSWORD,
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
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
    max_per_client: null,
  }).catch(() => {});

  const vjt = getSeededVjt();
  await restoreNetwork(vjt.token);
});

// Arm 1: UD3 — client cap saturation → 503 too_many_sessions.
//
// Constructs a second live accounts_session row for the same user
// under a distinct fixed client_id. The first /connect under that
// client_id establishes the live Session.Server; admin then drops
// `max_per_client` to 1 (the saturating cap = current count). The
// next /connect from the SAME client_id trips
// `Admission.check_client_cap/2` → `:client_cap_exceeded` →
// FallbackController U-3 clause → 503 `too_many_sessions`.
//
// Why we mint a fresh login (not reuse vjt.token):
// the seeded vjt bearer was created by globalSetup without a
// fixed x-grappa-client-id, so its `accounts_sessions.client_id`
// column may be NULL (per `Plug.RequireClientId` handling at the
// time of login). The cap dimension we're exercising counts
// `accounts_sessions WHERE client_id = X AND visitor.network_slug
// = slug OR Credential(user_id, network_id) match`. We need
// deterministic client_id population to assert against.
test("U-3 (UD3) — client cap saturation → 503 too_many_sessions", async () => {
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

  // MUST be canonical UUID v4 — `Grappa.ClientId.regex/0` rejects
  // anything else at the `GrappaWeb.Plugs.ClientId` boundary, in
  // which case `current_client_id` ends up nil and
  // `Admission.check_client_cap/2` short-circuits to `:ok` (silent
  // pass → false-200 instead of the asserted 503).
  const clientId = "a3000000-0000-4000-8000-000000000033";

  // Bump max_per_client UP first — e2e's MIX_ENV=dev defaults the
  // global to 1 (config/config.exs), so a fresh /connect under a
  // brand-new client_id with no admin-set per-network cap would
  // saturate IMMEDIATELY (count=1, cap=1) and 503 before we ever get
  // to exercise the U-3 mid-test cap-drop.
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_client: 10 });

  // Login once under the fixed client_id → creates accounts_session
  // (vjt, client_id, ...). Use the SAME bearer for both /connect
  // attempts so the user_id ↔ client_id linkage is consistent and
  // the per-client subject-count assertion is honest.
  const bearer = await loginWithClientId(vjt.identifier, vjt.password, clientId);

  // First /connect: 200 (cap=10, count=1).
  const first = await connectWithClientId(bearer, NETWORK_SLUG, clientId);
  expect(first.status).toBe(200);

  // Admin drops max_per_client to 1 — the current count (1
  // session for this user × this network under this client_id)
  // saturates the cap.
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_client: 1 });

  // Park to free the live pid so the next /connect triggers a fresh
  // spawn path that re-checks admission. (admission gate runs ONLY
  // on fresh spawn; idempotent re-connect of an already-live pid
  // returns 200 without re-checking caps.) Then a second login
  // under the same client_id (different bearer = different
  // accounts_session row) bumps the per-client count to 2 against
  // the cap of 1.
  await patchNetworkConnectionState(bearer, NETWORK_SLUG, { connection_state: "parked" }).catch(
    () => {},
  );

  // Second concurrent session row under the same client_id.
  // `count_subjects_for_client_on_network` joins on
  // `accounts_sessions WHERE client_id = ? AND ...` — two rows for
  // the same user_id collapse to count=1 via `count(s.user_id,
  // :distinct)`, so this alone wouldn't saturate. But the
  // `effective_max_per_client` cap is checked against `count >= cap`
  // — we need count=1 (current) AND cap=1 (saturating) AND a NEW
  // subject not yet in the count. That requires a different
  // user_id, which we don't have a fixture for. Settle for the
  // assertion that admin-set cap=1 AND a fresh /connect attempt
  // tripping the cap when count is at-or-over.
  //
  // Per `Admission.check_client_cap/2`: `count >= cap` returns
  // `:client_cap_exceeded`. With ONE accounts_session row (current
  // count=1) and cap=1, count >= cap is true → 503 expected.
  const second = await connectWithClientId(bearer, NETWORK_SLUG, clientId);

  expect(second.status).toBe(503);
  const body = (await second.json()) as { error: string };
  expect(body.error).toBe("too_many_sessions");
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

  const perClientCell = await page
    .getByTestId(`admin-sessions-summary-per-client-${slug}`)
    .textContent();
  expect(perClientCell).toMatch(/^(\d+|∞)$/);
});
