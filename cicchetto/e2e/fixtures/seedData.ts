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
export const M9B_NICK = "m9b-grappa";

const TOKEN_ENV_VAR = "E2E_VJT_TOKEN";
const SUBJECT_ENV_VAR = "E2E_VJT_SUBJECT";
const ADMIN_TOKEN_ENV_VAR = "E2E_ADMIN_TOKEN";
const ADMIN_SUBJECT_ENV_VAR = "E2E_ADMIN_SUBJECT";

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
