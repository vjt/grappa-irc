// UX-5 bucket BC (2026-05-19) — cap-on-park unblocker.
//
// vjt 2026-05-19 dogfood repro: in cic, click X on the network header →
// network parks (T32 transition: connection_state := :parked,
// Session.Server terminates). Then type `/connect <network>` → server
// returned 503 `too_many_sessions` (envelope: `:client_cap_exceeded`).
// The X-button was supposed to be the in-band "park without losing
// slot" verb — pre-BC it was effectively "park PLUS pay the cap,"
// worse than `/quit` because the slot stayed occupied.
//
// Root cause: `Admission.check_client_cap/2` counted the requesting
// user's OWN pre-existing accounts_session against the cap. With the
// production default `max_per_ip = 1` (config/config.exs), the
// count was always 1 for the operator's own browser session →
// `count >= cap` → 503. T32 park was a red herring; the bug fired on
// any first PATCH /connect from a logged-in user under default cap.
//
// Fix: `capacity_input.requesting_subject` is threaded through to the
// count clauses, which exclude rows attributable to that subject. The
// cap blocks DIFFERENT subjects on the same device (the genuine
// device-cap invariant), never the requesting subject's own session.
//
// This spec exercises the END-TO-END HTTP boundary at production wire
// shape: cic-style POST /auth/login with `x-grappa-client-id`, then
// PATCH /networks/:slug `connection_state=parked` (T32 X-button verb),
// then PATCH `connection_state=connected` (`/connect` slash-command +
// future Home `[Reconnect]` CTA) — all carrying the same client_id
// the browser would send. Pre-BC the second PATCH 503s; post-BC it
// 200s and the channels autojoin re-lands.
//
// Subject-shape: per `feedback_e2e_user_class_parity_matrix` this
// server-side fix is subject-agnostic (the count clauses are disjoint
// per subject_kind, and the visitor mirror is covered by the unit
// test `requesting subject's own session does NOT block visitor
// login-existing path`). One registered-user arm is sufficient at the
// e2e layer; the cross-clause disjointness invariant is unit-pinned.
//
// Members-list assertion (per `feedback_e2e_visitor_members_list`):
// post-rejoin the autojoin channel MUST repopulate its members list
// (count > 0, own nick included). Catches a hypothetical regression
// where /connect succeeds at the HTTP boundary but the spawn dance
// half-completes (Session.Server up, autojoin loop silently failing).

import { expect, test } from "../fixtures/test";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { patchNetworkConnectionState } from "../fixtures/grappaApi";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Production cap default is 1 (config/config.exs:68). Pre-BC, any
// /connect carrying a client_id whose accounts_session was minted with
// that same client_id would 503. We use a fixed canonical UUID v4 so
// the failure mode is deterministic (anything else `GrappaWeb.Plugs.ClientId`
// silently coerces to nil at the boundary → check_client_cap short-
// circuits via the nil-client clause → false-200).
const BUCKET_BC_CLIENT_ID = "b5000000-0000-4000-8000-000000000bc1";

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
  return ((await res.json()) as { token: string }).token;
}

async function patchConnectionWithClientId(
  token: string,
  clientId: string,
  body: { connection_state: "parked" | "connected"; reason?: string },
): Promise<Response> {
  return fetch(`${GRAPPA_BASE_URL}/networks/${encodeURIComponent(NETWORK_SLUG)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-grappa-client-id": clientId,
    },
    body: JSON.stringify(body),
  });
}

async function fetchChannels(
  token: string,
): Promise<Array<{ name: string; joined: boolean }>> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetchChannels: ${res.status}`);
  return (await res.json()) as Array<{ name: string; joined: boolean }>;
}

async function fetchChannelMembers(
  token: string,
  channel: string,
): Promise<string[]> {
  const res = await fetch(
    `${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels/${encodeURIComponent(channel)}/members`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) throw new Error(`fetchChannelMembers: ${res.status}`);
  const body = (await res.json()) as { members: Array<{ nick: string }> };
  return body.members.map((m) => m.nick);
}

// Test timeout bumped to 90s — afterEach restores the network to
// :connected via patchNetworkConnectionState which polls up to 30s
// for autojoin completion. Body itself runs in ~5-10s. Matches the
// cp15-b6-parked-disconnect-reconnect.spec.ts budget for parked-flow specs.
test.setTimeout(90_000);

test.afterEach(async () => {
  // Restore vjt to :connected so the next spec sees a healthy
  // baseline. The bucket-BC client_id is throwaway (its accounts_session
  // stays in the DB but only adds 1 row; cleanup not load-bearing).
  const vjt = getSeededVjt();
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});

  for (let attempt = 0; attempt < 60; attempt++) {
    const channels = await fetchChannels(vjt.token).catch(() => null);
    if (channels?.find((c) => c.name === SEED_CHANNEL)?.joined) return;
    await new Promise((r) => setTimeout(r, 500));
  }
});

test("UX-5 BC — park then /connect from the same source IP succeeds (self-exclusion)", async () => {
  const vjt = getSeededVjt();

  // Mint a fresh accounts_session(vjt) via cic-style POST /auth/login.
  // Pre-BC this row was counted against vjt himself for the subsequent
  // /connect → 503. Post-BC (#171: the cap is per-source-IP) the
  // requesting-subject self-exclusion drops vjt's own row from the count
  // → /connect 200s. The tight-cap load-bearing case is unit-covered
  // (networks_controller_test UX-5 BC); this proves the gated /connect
  // path admits the returning subject end-to-end.
  const bearer = await loginWithClientId(
    vjt.identifier,
    vjt.password,
    BUCKET_BC_CLIENT_ID,
  );

  // Step 1 — park (T32 X-button equivalent). The DB row flips to
  // :parked, Session.Server terminates. accounts_session stays alive
  // (the browser is still logged in; only the IRC session is parked).
  const parkRes = await patchConnectionWithClientId(bearer, BUCKET_BC_CLIENT_ID, {
    connection_state: "parked",
    reason: "ux-5-bc dogfood repro",
  });
  expect(parkRes.status).toBe(200);

  // Step 2 — /connect under the same client_id. Pre-BC: 503
  // too_many_sessions because vjt's own accounts_session counts
  // against him. Post-BC: 200, spawn dance succeeds.
  const connectRes = await patchConnectionWithClientId(bearer, BUCKET_BC_CLIENT_ID, {
    connection_state: "connected",
  });

  expect(connectRes.status).toBe(200);
  const connectBody = (await connectRes.json()) as { connection_state: string };
  expect(connectBody.connection_state).toBe("connected");

  // Step 3 — verify the spawn dance actually completed (Session.Server
  // up + autojoin re-landed). Without this assertion the test would
  // pass on a half-spawned regression where /connect returns 200 but
  // the autojoin loop silently fails. Polls /networks/:slug/channels
  // until #bofh shows joined.
  let joined = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const channels = await fetchChannels(bearer).catch(() => null);
    if (channels?.find((c) => c.name === SEED_CHANNEL)?.joined) {
      joined = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(joined).toBe(true);

  // Step 4 — members-list invariant (per feedback_e2e_visitor_members_list,
  // generalised to all classes for parity). Post-rejoin the autojoin
  // channel MUST surface a populated members list including the
  // operator's own nick. Catches a regression where /connect succeeds
  // at the HTTP boundary but state.members never repopulates.
  let members: string[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    members = await fetchChannelMembers(bearer, SEED_CHANNEL).catch(() => []);
    if (members.length > 0 && members.includes(NETWORK_NICK)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(members.length).toBeGreaterThan(0);
  expect(members).toContain(NETWORK_NICK);
});
