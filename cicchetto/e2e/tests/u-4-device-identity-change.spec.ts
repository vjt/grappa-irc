// U-4 — Device identity change (UD5.A + UD5.B + UD5.C).
//
// ⚠️ DEFERRED — see "Why this is test.skip" below. The U-4 invariants
// are pinned at unit-level by:
//   - `test/grappa_web/controllers/auth_controller_test.exs` —
//     "UD5.A: visitor logout is synchronous — :DOWN arrives BEFORE
//     204 returns" + the 6 pre-existing logout tests (visitor anon /
//     visitor reg / user single bind / user multi-bind / disconnect-
//     broadcast variants). Runs in `Phoenix.ConnTest` against the
//     real `AuthController.logout/2` → `Session.stop_session/2` →
//     `Accounts.revoke_session/1` path through real `Visitors.Login`-
//     spawned `Session.Server`s talking to an in-process IRC fake
//     (`Grappa.IRCServer`). End-to-end at the BEAM layer minus the
//     HTTP socket; transport-level coverage is `Phoenix.ConnTest`'s.
//   - `test/grappa/admission_test.exs` — 4 new tests in describe
//     "check_capacity/1 — client cap subject-aware (UD5.B)" covering
//     visitor→user cross-kind, user→visitor cross-kind, same-kind
//     saturation (sanity), and revoked-session-doesn't-count
//     (UD5.A+UD5.B composition). Exercises the actual
//     `count_subjects_for_client_on_network/3` SQL clauses with real
//     `accounts_sessions` + `visitors` + `credentials` rows in
//     Ecto sandbox.
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
// Why this is test.skip:
//
// The strongest end-to-end assertion would be: visitor mint on
// client_id X → cap drops to 1 → visitor logout → user login on
// SAME client_id X → /connect succeeds (the cross-kind UD5.B
// guarantee). That requires a successful visitor mint against the
// real bahamut-test ircd inside the e2e harness, which hits
// `feedback_visitor_mint_e2e_cold_start` 504: the synchronous
// `:login_probe_timeout_ms` (3s) is exhausted by the first-
// connection IRC handshake latency (rDNS lookup + USER/NICK +
// 001). Same blocker as M-8 (`m8-admin-visitors-delete.spec.ts`).
//
// Workarounds considered + rejected:
//   - Pre-seed a visitor row at compose-time — out of U-4 scope
//     (separate seeder change touching `cicchetto/e2e/compose.yaml`
//     + sidecar mix-run command). Tracked in
//     `feedback_visitor_mint_e2e_cold_start`.
//   - Raise `login_probe_timeout_ms` in e2e config — blast radius
//     too large; would mask production-realistic timeouts in OTHER
//     specs that depend on the 3s default to surface as 504.
//   - Substitute same-user-different-bearer for cross-kind — DOES
//     NOT exercise UD5.B's subject-aware filter (the new user login
//     itself contributes 1 to the count of the same kind, so the
//     saturating cap=1 always 503s regardless of UD5.B's correctness).
//     The test would prove only that the second login row exists,
//     not that the slot was freed.
//
// Unit-level coverage (the two test files cited above) is
// comprehensive AND tests real DB rows + real Session.Servers — the
// `e2e` gap is purely about the HTTP socket layer + browser
// JavaScript, which neither UD5.A nor UD5.B touch. The Playwright
// file stays in the tree as a loud `test.skip` so the next operator
// working on visitor-mint e2e sees the intent and re-enables it
// once the cold-start gap is closed.

import { test } from "@playwright/test";

test.skip("U-4 (UD5.A+B+C) — logout frees client_id slot for cross-kind re-login", () => {
  // See moduledoc — visitor mint 504s on e2e cold-start; the
  // UD5.A + UD5.B invariants are pinned at unit-level via
  // auth_controller_test.exs + admission_test.exs respectively.
  // Re-enable once `feedback_visitor_mint_e2e_cold_start` lands a
  // pre-seeded visitor row pattern.
});
