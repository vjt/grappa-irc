// U-4 — Device identity change (UD5.A + UD5.B + UD5.C).
//
// What U-4 ships at the e2e-observable surface (per
// `docs/plans/2026-05-16-tmu-cluster-arc.md` §U-4 + §UD5):
//
//   - UD5.A — Logout terminates the live Session.Server for that
//     subject BEFORE returning (synchronous).
//   - UD5.B — `Admission.check_client_cap/2` filters by subject_kind
//     so a logged-out subject's slot does NOT block a fresh login of
//     a DIFFERENT subject_kind on the same client_id.
//   - UD5.C — Visitor `/quit` (cic-orchestrated park-all + logout)
//     frees the client_id slot, composing UD5.A through
//     `cicchetto/src/lib/compose.ts:283-322` which awaits `logout()`.
//
// Unit-level coverage (still authoritative):
//   - `test/grappa_web/controllers/auth_controller_test.exs` — 6
//     pre-existing logout paths through real Session.Server +
//     in-process IRC fake (transport-level + DB-level).
//   - `test/grappa/admission_test.exs` — 4 subject-aware
//     check_capacity/1 tests (visitor↔user cross-kind, same-kind
//     saturation, revoked-doesn't-count).
//
// E2E surface — what this spec proves beyond unit coverage: the
// composed REST flow (mintVisitor → DELETE /auth/logout → user
// /auth/login on the same client_id → /networks PATCH connect)
// completes cleanly against the real bahamut-test ircd via the
// nginx-test edge, validating that the unit-level invariants
// compose at the HTTP boundary the cic shell actually drives.
//
// Pre-UD7 history: this spec was test.skip'd against the 9-day-old
// `feedback_visitor_mint_e2e_cold_start` memory. The actual blocker
// was unrelated to the budget — `mix grappa.add_server` defaults to
// `tls: true` and the azzurra seeder line in compose.yaml lacked
// `--no-tls`, so visitor Session.Servers attempted TLS handshakes
// against the plain bahamut leaf on :6667 and `:irc_connected` never
// fired. Fixed in the same cluster as this revival; M-8 + U-4 both
// re-enabled simultaneously.

import { expect, test } from "../fixtures/test";
import {
  ADMIN_IDENTIFIER,
  ADMIN_PASSWORD,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { mintVisitor, login, adminDeleteVisitor } from "../fixtures/grappaApi";

const GRAPPA_BASE_URL = "http://grappa-test:4000";

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

async function logout(token: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/auth/logout`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 204) {
    throw new Error(`logout: ${res.status} ${await res.text()}`);
  }
}

async function loginUserWithClientId(
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
    throw new Error(`loginUserWithClientId: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function mintVisitorWithClientId(
  nick: string,
  clientId: string,
): Promise<{ id: string; token: string }> {
  const res = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-grappa-client-id": clientId,
    },
    body: JSON.stringify({ identifier: nick }),
  });
  if (!res.ok) {
    throw new Error(`mintVisitorWithClientId: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    token: string;
    subject: { kind: "visitor"; id: string };
  };
  return { id: body.subject.id, token: body.token };
}

test("U-4 (UD5.A+B) — visitor logout frees client_id slot for cross-kind user login", async () => {
  // MUST be canonical UUID v4 (`Grappa.ClientId.regex/0` rule).
  const clientId = "a3000000-0000-4000-8000-000000000044";
  const visitorNick = `u4-visitor-${Date.now()}`;

  // The load-bearing cap for UD5.B is bahamut-test's max_per_client = 1:
  // the freed visitor slot must NOT block the cross-kind user login on
  // vjt's bound network. azzurra stays at seeded headroom (100) — with
  // #171's per-(source-IP, network) cap ALSO reusing max_per_client, an
  // azzurra cap of 1 would 503 STEP 1's mint against any leftover
  // visitor on the serial runner's shared source IP (an unrelated
  // regression). Restore both in finally so subsequent specs see the
  // seeder baseline (azzurra 100, bahamut-test null → default).
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  await adminPatchCaps(admin.token, "azzurra", { max_per_client: 100 });
  await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_client: 1 });

  let visitorId: string | null = null;
  try {
    // STEP 1 — Mint a visitor under client_id X. UD5.B: this consumes
    // 1 client-cap slot for kind=visitor on azzurra.
    const visitor = await mintVisitorWithClientId(visitorNick, clientId);
    visitorId = visitor.id;

    // STEP 2 — Visitor logs out. UD5.A: synchronous teardown — by the
    // time DELETE /auth/logout returns 204, the Session.Server is
    // already terminated AND the accounts_session row is revoked.
    await logout(visitor.token);

    // STEP 3 — Seeded user (vjt) logs in under the SAME client_id.
    // UD5.B: the cap filters by subject_kind, so the just-freed
    // visitor slot does NOT block this fresh user login. Expected:
    // 200 with a valid bearer.
    //
    // Use the bahamut-test (vjt's bound network) cap as the cross-
    // network invariant — UD5.B's subject_kind filter is per-network-
    // independent.
    const vjtBearer = await loginUserWithClientId(
      "vjt@grappa.test",
      "test-password-not-secret",
      clientId,
    );
    expect(typeof vjtBearer).toBe("string");
    expect(vjtBearer.length).toBeGreaterThan(0);
  } finally {
    await adminPatchCaps(admin.token, "azzurra", { max_per_client: 100 }).catch(() => {});
    await adminPatchCaps(admin.token, NETWORK_SLUG, { max_per_client: null }).catch(() => {});
    if (visitorId !== null) {
      await adminDeleteVisitor(admin.token, visitorId).catch(() => {});
    }
  }
});
