// Playwright global-setup. Runs ONCE before any spec.
//
// Seeding (user `vjt` + bahamut-test bind w/ autojoin `["#bofh"]`,
// plus M-cluster M-7 admin user `admin-vjt`) happens in the
// `grappa-e2e-seeder` sidecar BEFORE grappa-test boots, so by the
// time this runs the users already exist in the DB and grappa's
// Bootstrap has spawned the upstream IRC sessions for those with
// a network bind (vjt). This setup only:
//   1. Logs in as the seeded non-admin user (vjt)
//   2. Logs in as the seeded admin user (admin-vjt; M-7)
//   3. Stashes both bearer tokens in env vars for specs to read
//
// Constants in this file MUST stay in sync with the seeder command in
// cicchetto/e2e/compose.yaml — they're the contract. (A future move
// might invert it: emit a JSON manifest from the seeder for the runner
// to read; not worth it for two users.)

import { login, type SeededUser } from "./grappaApi";

// GREEN-CI-3 B3 (2026-05-23) — cold-start retry around login() calls
// invoked from globalSetup. globalSetup runs FOUR logins back-to-back
// (vjt, admin, m9b-test, m9b-victim) against a freshly-booted grappa-
// test container; any transient 5xx from the first-contact boundary
// (e.g. Bootstrap's Session.Servers mid-welcome handshake against
// bahamut-test) throws → entire Playwright run aborts before any spec
// executes. The retry is a generic boundary-probe defense (pattern
// shared with assertMessagePersisted / awaitPushDelivery): exponential
// backoff swallows the first 1-2 boundary-flake responses, attempt 3
// surfaces the real failure if the upstream is genuinely broken.
async function loginWithRetry(
  identifier: string,
  password: string,
  attempts = 3,
): ReturnType<typeof login> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await login(identifier, password);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const backoffMs = 2000 * 2 ** i; // 2s, 4s, 8s
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw new Error(
    `loginWithRetry: ${identifier} failed after ${attempts} attempts: ${String(lastErr)}`,
  );
}

export const VJT_USER = "vjt";
export const VJT_PASSWORD = "test-password-not-secret";
export const VJT_IDENTIFIER = "vjt@grappa.test";

export const NETWORK_SLUG = "bahamut-test";
export const NETWORK_NICK = "vjt-grappa";
export const AUTOJOIN_CHANNELS = ["#bofh"];

// M-cluster M-7 — admin user. Seeded via mix run -e in the seeder
// sidecar after `create_user` (no --admin flag on the mix task; M-7
// is cic-only). Identifier shape mirrors VJT_IDENTIFIER (email-like
// `name@grappa.test` is the seeder convention, NOT a real domain).
export const ADMIN_USER = "admin-vjt";
export const ADMIN_PASSWORD = "test-password-not-secret";
export const ADMIN_IDENTIFIER = "admin-vjt@grappa.test";

// M-cluster M-9b — third seeded user, bound to bahamut-test so
// Bootstrap spawns a live Session.Server. The admin spec disconnects
// THIS user's session (not admin-vjt's, which would trip the M-9a
// 422 cannot_disconnect_self gate).
export const M9B_USER = "m9b-test";
export const M9B_PASSWORD = "test-password-not-secret";
export const M9B_IDENTIFIER = "m9b-test@grappa.test";
export const M9B_NICK = "m9b-grappa";

// GREEN-CI batch-1 — sacrificial user dedicated to destructive admin
// specs (Disconnect, Terminate). Disconnect parks the credential
// (Bootstrap pid stops, row drops from /admin/sessions); Terminate
// kills the live pid. Without this dedicated victim, the destructive
// specs used `.first()` and randomly hit vjt's session, cascading
// "sidebar empty → selectChannel times out at 30s" failures across
// every downstream vjt-using spec. Each destructive spec begins with
// a /networks PATCH to reconnect m9b-victim (idempotent if already
// connected) so the spec starts from a known live state.
export const M9B_VICTIM_USER = "m9b-victim";
export const M9B_VICTIM_PASSWORD = "test-password-not-secret";
export const M9B_VICTIM_IDENTIFIER = "m9b-victim@grappa.test";
export const M9B_VICTIM_NICK = "m9b-victim-grappa";

// #481 — dedicated user for the self-serve accretion e2e. Created with NO
// network bind: post-#481 a USER sees the `visitor_enabled` (operator-
// approved) self-serve tier on home and can one-tap CONNECT one. The spec
// logs in as this user (loginAs) and one-taps azzurra2 — SOLANUM, an
// independent nick namespace, so the shared-leaf 433 trap
// (feedback_e2e_multinet_live_needs_distinct_nicks) never fires — then
// asserts it connects LIVE. ISOLATED (its own user) so the live session it
// leaves on azzurra2 has zero blast radius: the azzurra2 visitor-cap pool
// is subject-kind-separate from this USER session (U-1 split).
export const ACCRETE_USER = "accr481";
export const ACCRETE_PASSWORD = "test-password-not-secret";
export const ACCRETE_IDENTIFIER = "accr481@grappa.test";
export const ACCRETE_NETWORK_SLUG = "azzurra2";

// #1038 — dedicated user for the cross-network mute e2e. NO bind at seed
// time: the spec accretes BOTH slugs below at runtime, because what it has to
// witness is ONE subject holding the SAME channel name on TWO networks.
//
// The two slugs are on DIFFERENT ircds (azzurra → bahamut-test,
// azzurra2 → bahamut-test2), which buys two things at once: the two sessions
// cannot collide on nick even though both default to the account name
// (feedback_e2e_multinet_live_needs_distinct_nicks), and the same channel
// name genuinely IS two conversations rather than one room seen twice.
//
// Isolated from vjt deliberately — see the compose.yaml comment: the auto
// subject reset re-spawns every credential and never removes an accreted one.
export const MUTE1038_USER = "mute1038";
export const MUTE1038_PASSWORD = "test-password-not-secret";
export const MUTE1038_IDENTIFIER = "mute1038@grappa.test";
export const MUTE1038_NETWORK_A = "azzurra";
export const MUTE1038_NETWORK_B = "azzurra2";
export const MUTE1038_HOST_A = "bahamut-test";
export const MUTE1038_HOST_B = "bahamut-test2";

// GH #349 — dedicated user for the registration-wizard real-services
// e2e. Bound to `azzurra-reg` (services_flavor=azzurra) with a FRESH
// unregistered nick, so the "Register nick" button shows and the spec
// can register it against the (email-enabled) azzurra services + read
// the AUTH code from mailpit. Isolated from vjt so the new button has
// zero blast radius on the other HomePane specs.
export const WIZ_USER = "wiz-test";
export const WIZ_PASSWORD = "test-password-not-secret";
export const WIZ_IDENTIFIER = "wiz-test@grappa.test";
export const WIZ_NETWORK_SLUG = "azzurra-reg";
export const WIZ_NICK = "wiz-reg-nick";

// #405 — a FRESH non-admin account with NO network bind (seeded via
// `mix grappa.create_user --name fresh405` in compose.yaml, no
// bind_network + no --admin). The first-login journey spec logs in with
// the BARE name (NO `@`) to exercise the #404 dispatch fix through cic,
// then asserts the USER (not guest) empty-networks home state. Unlike the
// other seeded users this is NOT logged in at globalSetup — the spec
// drives the real login form itself, so there is no stashed token. The
// identifier IS the bare name (no `name@grappa.test` email shape): a bare
// account name is exactly what #404 must resolve to the account, not a guest.
export const FRESH_USER = "fresh405";
export const FRESH_PASSWORD = "test-password-not-secret";

// #498 — dedicated user for the badge-follows-live-nick witness
// (b-runtime). The witness renames a session's LIVE nick — a destructive
// mutation of server-side identity — so it never touches the shared vjt
// session (#477-avoided class). The spec accretes its OWN session at
// runtime and parks it on teardown, so it stays OUT of the steady state
// m9b (leak canary) + u-z-cap (user-cap) assert AFTER it (a boot-live
// session reddened both the full suite and scoped `--grep m9b` reruns).
// bahamut-test is NOT visitor_enabled, so the spec accretes `azzurra` —
// visitor_enabled AND pointing at the SAME leaf (bahamut-test:6667), so
// the peer sees the session with no extra wiring and it consumes no
// bahamut-test user-cap slot.
export const I498_USER = "i498-user";
export const I498_PASSWORD = "test-password-not-secret";
export const I498_IDENTIFIER = "i498-user@grappa.test";
// The anon accretion default nick = the account name: user_identity_seed
// falls back to `truncate_nick(name)` when the user holds no prior
// credential. Unique across the seeded set → no shared-leaf 433 autokill.
export const I498_NICK = "i498-user";
export const I498_CHANNEL = "#i498";
// #498 accretes `azzurra` (visitor_enabled, same leaf as bahamut-test),
// NOT bahamut-test (not visitor_enabled → not self-serve-accretable).
export const I498_NETWORK_SLUG = "azzurra";

// #630 — dedicated sacrificial user for the inbound-flood-protection e2e.
// The flood ladder's terminal rung is a SEVER: it REVOKES the flooded
// subject's web bearer and closes its socket. The e2e stack boots
// MIX_ENV=dev, whose `:request_budget` is ENFORCING (cap 200, sever at 30
// over-budget events in 10s) so #630 proves the real 429 + sever + banner
// full-stack — which means the flood MUST target a throwaway subject, never
// the shared vjt. Flooding vjt revoked the SINGLE globalSetup-minted vjt
// bearer every downstream vjt spec reuses, cascading auth-death across the
// whole tail of the 1-worker suite (issue630 sorts at ~208, immediately
// before issue66 + issue71-inc1 — exactly where that cascade began). Same
// class as the GREEN-CI batch-1 fix (destructive admin specs → m9b-victim)
// and the #498 witness (renames a LIVE nick → its OWN user): a DESTRUCTIVE
// spec gets a dedicated victim. Created NO network bind (only needs a valid
// web session to flood /me writes + be severed), so it consumes no
// bahamut-test user-cap slot and never appears in the /admin/sessions leak
// canary (registry-driven: one row = one live Session.Server pid).
export const FLOOD_VICTIM_USER = "flood-victim";
export const FLOOD_VICTIM_PASSWORD = "test-password-not-secret";
export const FLOOD_VICTIM_IDENTIFIER = "flood-victim@grappa.test";

const TOKEN_ENV_VAR = "E2E_VJT_TOKEN";
const SUBJECT_ENV_VAR = "E2E_VJT_SUBJECT";
const ADMIN_TOKEN_ENV_VAR = "E2E_ADMIN_TOKEN";
const ADMIN_SUBJECT_ENV_VAR = "E2E_ADMIN_SUBJECT";
const M9B_USER_ID_ENV_VAR = "E2E_M9B_USER_ID";
const M9B_VICTIM_TOKEN_ENV_VAR = "E2E_M9B_VICTIM_TOKEN";
const M9B_VICTIM_USER_ID_ENV_VAR = "E2E_M9B_VICTIM_USER_ID";
const WIZ_TOKEN_ENV_VAR = "E2E_WIZ_TOKEN";
const WIZ_SUBJECT_ENV_VAR = "E2E_WIZ_SUBJECT";
const ACCRETE_TOKEN_ENV_VAR = "E2E_ACCRETE_TOKEN";
const ACCRETE_SUBJECT_ENV_VAR = "E2E_ACCRETE_SUBJECT";
const MUTE1038_TOKEN_ENV_VAR = "E2E_MUTE1038_TOKEN";
const MUTE1038_SUBJECT_ENV_VAR = "E2E_MUTE1038_SUBJECT";
const I498_TOKEN_ENV_VAR = "E2E_I498_TOKEN";
const I498_SUBJECT_ENV_VAR = "E2E_I498_SUBJECT";
const FLOOD_VICTIM_TOKEN_ENV_VAR = "E2E_FLOOD_VICTIM_TOKEN";
const FLOOD_VICTIM_SUBJECT_ENV_VAR = "E2E_FLOOD_VICTIM_SUBJECT";

export default async function globalSetup(): Promise<void> {
  const result = await loginWithRetry(VJT_IDENTIFIER, VJT_PASSWORD);
  process.env[TOKEN_ENV_VAR] = result.token;
  // Stash the subject envelope as JSON. cicchettoPage.loginAs() seeds
  // it into localStorage before page bootstrap so cicchetto's auth.ts
  // sees a complete identity (token + subject) without driving the
  // login form. Cic reads `grappa-subject` to compute the socket
  // user_name (auth.ts socketUserName) — without it, the WS join
  // payload is wrong and channel topics are rejected as `forbidden`.
  process.env[SUBJECT_ENV_VAR] = JSON.stringify(result.subject);

  // M-7 — admin login. Parallel-shape to vjt; the M-7 spec uses
  // getSeededAdmin() to obtain the admin bearer + subject.
  const admin = await loginWithRetry(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  process.env[ADMIN_TOKEN_ENV_VAR] = admin.token;
  process.env[ADMIN_SUBJECT_ENV_VAR] = JSON.stringify(admin.subject);

  // M-9b — capture m9b-test's UUID so the admin Terminate spec can
  // target THAT row deterministically (vs. `.first()` which is
  // Registry-insertion-order non-deterministic and was killing vjt's
  // session, cascading sidebar-empty failures across every downstream
  // vjt-using spec — root cause of the GREEN-CI batch-1 cascade).
  const m9b = await loginWithRetry(M9B_IDENTIFIER, M9B_PASSWORD);
  process.env[M9B_USER_ID_ENV_VAR] = m9b.subject.id;

  // GREEN-CI batch-1 — sacrificial victim's token + UUID. Destructive
  // admin specs (Disconnect parks, Terminate kills the pid) target
  // THIS user; vjt + m9b-test stay alive for downstream specs. Token
  // is stashed so each destructive spec can PATCH /networks to
  // reconnect (idempotent) before firing the destructive verb,
  // guaranteeing a live session even if a prior spec parked it.
  const victim = await loginWithRetry(M9B_VICTIM_IDENTIFIER, M9B_VICTIM_PASSWORD);
  process.env[M9B_VICTIM_TOKEN_ENV_VAR] = victim.token;
  process.env[M9B_VICTIM_USER_ID_ENV_VAR] = victim.subject.id;

  // GH #349 — registration-wizard user. Bound to azzurra-reg; the spec
  // logs in as this user and drives the wizard against real services.
  const wiz = await loginWithRetry(WIZ_IDENTIFIER, WIZ_PASSWORD);
  process.env[WIZ_TOKEN_ENV_VAR] = wiz.token;
  process.env[WIZ_SUBJECT_ENV_VAR] = JSON.stringify(wiz.subject);

  // #481 — self-serve accretion user. NO network bind, so home shows the
  // self-serve "available to connect" tier; the spec one-taps azzurra2 and
  // asserts a LIVE connect.
  const accrete = await loginWithRetry(ACCRETE_IDENTIFIER, ACCRETE_PASSWORD);
  process.env[ACCRETE_TOKEN_ENV_VAR] = accrete.token;
  process.env[ACCRETE_SUBJECT_ENV_VAR] = JSON.stringify(accrete.subject);

  const mute1038 = await loginWithRetry(MUTE1038_IDENTIFIER, MUTE1038_PASSWORD);
  process.env[MUTE1038_TOKEN_ENV_VAR] = mute1038.token;
  process.env[MUTE1038_SUBJECT_ENV_VAR] = JSON.stringify(mute1038.subject);

  // #498 — badge-follows-live-nick witness user. Only the USER is seeded;
  // the spec accretes its OWN azzurra session at runtime and renames ITS
  // live nick (never vjt's). This login just stashes the bearer token.
  const i498 = await loginWithRetry(I498_IDENTIFIER, I498_PASSWORD);
  process.env[I498_TOKEN_ENV_VAR] = i498.token;
  process.env[I498_SUBJECT_ENV_VAR] = JSON.stringify(i498.subject);

  // #630 — sacrificial flood victim (see the constant's comment). Its bearer
  // is the one the flood spec revokes; stashed so the spec can loginAs it.
  const floodVictim = await loginWithRetry(FLOOD_VICTIM_IDENTIFIER, FLOOD_VICTIM_PASSWORD);
  process.env[FLOOD_VICTIM_TOKEN_ENV_VAR] = floodVictim.token;
  process.env[FLOOD_VICTIM_SUBJECT_ENV_VAR] = JSON.stringify(floodVictim.subject);
}

// #630 — the sacrificial flood victim (see FLOOD_VICTIM_USER). Same shape as
// getSeededVjt; distinct env keys. The flood spec loginAs-es THIS user so the
// sever revokes ITS bearer, never the shared vjt one downstream specs reuse.
export function getSeededFloodVictim(): SeededUser {
  const token = process.env[FLOOD_VICTIM_TOKEN_ENV_VAR];
  const subjectJson = process.env[FLOOD_VICTIM_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededFloodVictim: ${FLOOD_VICTIM_TOKEN_ENV_VAR}/${FLOOD_VICTIM_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: FLOOD_VICTIM_USER,
    password: FLOOD_VICTIM_PASSWORD,
    identifier: FLOOD_VICTIM_IDENTIFIER,
    token,
    subjectJson,
  };
}

export function getSeededVjt(): SeededUser {
  const token = process.env[TOKEN_ENV_VAR];
  const subjectJson = process.env[SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededVjt: ${TOKEN_ENV_VAR}/${SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: VJT_USER,
    password: VJT_PASSWORD,
    identifier: VJT_IDENTIFIER,
    token,
    subjectJson,
  };
}

// M-cluster M-7 — admin variant for the admin-gate parity spec.
// Same shape as getSeededVjt; distinct env keys.
export function getSeededAdmin(): SeededUser {
  const token = process.env[ADMIN_TOKEN_ENV_VAR];
  const subjectJson = process.env[ADMIN_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededAdmin: ${ADMIN_TOKEN_ENV_VAR}/${ADMIN_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: ADMIN_USER,
    password: ADMIN_PASSWORD,
    identifier: ADMIN_IDENTIFIER,
    token,
    subjectJson,
  };
}

// GH #349 — registration-wizard user (token + subject) for loginAs.
export function getSeededWizUser(): SeededUser {
  const token = process.env[WIZ_TOKEN_ENV_VAR];
  const subjectJson = process.env[WIZ_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededWizUser: ${WIZ_TOKEN_ENV_VAR}/${WIZ_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: WIZ_USER,
    password: WIZ_PASSWORD,
    identifier: WIZ_IDENTIFIER,
    token,
    subjectJson,
  };
}

// #1038 — cross-network mute user (token + subject) for loginAs.
export function getSeededMute1038User(): SeededUser {
  const token = process.env[MUTE1038_TOKEN_ENV_VAR];
  const subjectJson = process.env[MUTE1038_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededMute1038User: ${MUTE1038_TOKEN_ENV_VAR}/${MUTE1038_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: MUTE1038_USER,
    password: MUTE1038_PASSWORD,
    identifier: MUTE1038_IDENTIFIER,
    token,
    subject: JSON.parse(subjectJson) as SeededUser["subject"],
  };
}

// #481 — self-serve accretion user (token + subject) for loginAs.
export function getSeededAccreteUser(): SeededUser {
  const token = process.env[ACCRETE_TOKEN_ENV_VAR];
  const subjectJson = process.env[ACCRETE_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededAccreteUser: ${ACCRETE_TOKEN_ENV_VAR}/${ACCRETE_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: ACCRETE_USER,
    password: ACCRETE_PASSWORD,
    identifier: ACCRETE_IDENTIFIER,
    token,
    subjectJson,
  };
}

// #498 — badge-follows-live-nick witness user (token + subject) for loginAs.
export function getSeededI498User(): SeededUser {
  const token = process.env[I498_TOKEN_ENV_VAR];
  const subjectJson = process.env[I498_SUBJECT_ENV_VAR];
  if (!token || !subjectJson) {
    throw new Error(
      `getSeededI498User: ${I498_TOKEN_ENV_VAR}/${I498_SUBJECT_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: I498_USER,
    password: I498_PASSWORD,
    identifier: I498_IDENTIFIER,
    token,
    subjectJson,
  };
}

// M-9b — m9b-test user UUID, captured in globalSetup. Returns the full
// composite admin-session id (`user:UUID:NETWORK_ID`) the admin
// Sessions tab uses for its testids, so callers don't re-derive the
// shape. NETWORK_ID is always 1 in the e2e seeder (single-network
// bahamut-test). Throws if globalSetup didn't run.
export function getSeededM9bSessionId(): string {
  const userId = process.env[M9B_USER_ID_ENV_VAR];
  if (!userId) {
    throw new Error(
      `getSeededM9bSessionId: ${M9B_USER_ID_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return `user:${userId}:1`;
}

// GREEN-CI batch-1 — sacrificial victim's composite session id +
// reconnect token. The session id matches what AdminSessionsTab
// renders (`user:UUID:NETWORK_ID`), so destructive specs use
// `getByTestId('admin-session-{action}-{returnedId}')`. The token
// is for the spec to PATCH /networks/bahamut-test {connection_state:
// connected} (as m9b-victim itself) BEFORE firing the destructive
// verb — guarantees a live session regardless of prior-spec parking.
export function getSeededM9bVictim(): { sessionId: string; token: string } {
  const userId = process.env[M9B_VICTIM_USER_ID_ENV_VAR];
  const token = process.env[M9B_VICTIM_TOKEN_ENV_VAR];
  if (!userId || !token) {
    throw new Error(
      `getSeededM9bVictim: ${M9B_VICTIM_USER_ID_ENV_VAR}/${M9B_VICTIM_TOKEN_ENV_VAR} not set. ` +
        `Did playwright globalSetup run?`,
    );
  }
  return { sessionId: `user:${userId}:1`, token };
}
