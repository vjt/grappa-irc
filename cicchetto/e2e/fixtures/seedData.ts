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

const TOKEN_ENV_VAR = "E2E_VJT_TOKEN";
const SUBJECT_ENV_VAR = "E2E_VJT_SUBJECT";
const ADMIN_TOKEN_ENV_VAR = "E2E_ADMIN_TOKEN";
const ADMIN_SUBJECT_ENV_VAR = "E2E_ADMIN_SUBJECT";
const M9B_USER_ID_ENV_VAR = "E2E_M9B_USER_ID";
const M9B_VICTIM_TOKEN_ENV_VAR = "E2E_M9B_VICTIM_TOKEN";
const M9B_VICTIM_USER_ID_ENV_VAR = "E2E_M9B_VICTIM_USER_ID";

export default async function globalSetup(): Promise<void> {
  const result = await login(VJT_IDENTIFIER, VJT_PASSWORD);
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
  const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
  process.env[ADMIN_TOKEN_ENV_VAR] = admin.token;
  process.env[ADMIN_SUBJECT_ENV_VAR] = JSON.stringify(admin.subject);

  // M-9b — capture m9b-test's UUID so the admin Terminate spec can
  // target THAT row deterministically (vs. `.first()` which is
  // Registry-insertion-order non-deterministic and was killing vjt's
  // session, cascading sidebar-empty failures across every downstream
  // vjt-using spec — root cause of the GREEN-CI batch-1 cascade).
  const m9b = await login(M9B_IDENTIFIER, M9B_PASSWORD);
  process.env[M9B_USER_ID_ENV_VAR] = m9b.subject.id;

  // GREEN-CI batch-1 — sacrificial victim's token + UUID. Destructive
  // admin specs (Disconnect parks, Terminate kills the pid) target
  // THIS user; vjt + m9b-test stay alive for downstream specs. Token
  // is stashed so each destructive spec can PATCH /networks to
  // reconnect (idempotent) before firing the destructive verb,
  // guaranteeing a live session even if a prior spec parked it.
  const victim = await login(M9B_VICTIM_IDENTIFIER, M9B_VICTIM_PASSWORD);
  process.env[M9B_VICTIM_TOKEN_ENV_VAR] = victim.token;
  process.env[M9B_VICTIM_USER_ID_ENV_VAR] = victim.subject.id;
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
