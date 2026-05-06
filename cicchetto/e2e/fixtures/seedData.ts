// Playwright global-setup. Runs ONCE before any spec.
//
// Seeding (user `vjt` + bahamut-test bind w/ autojoin `["#bofh"]`)
// happens in the `grappa-e2e-seeder` sidecar BEFORE grappa-test
// boots, so by the time this runs the user already exists in the DB
// and grappa's Bootstrap has spawned the upstream IRC session.
// This setup only:
//   1. Logs in as the seeded user
//   2. Stashes the bearer token in `E2E_VJT_TOKEN` for specs to read
//
// Constants in this file MUST stay in sync with the seeder command in
// cicchetto/e2e/compose.yaml — they're the contract. (A future move
// might invert it: emit a JSON manifest from the seeder for the runner
// to read; not worth it for one user.)

import { login, type SeededUser } from "./grappaApi";

export const VJT_USER = "vjt";
export const VJT_PASSWORD = "test-password-not-secret";
export const VJT_IDENTIFIER = "vjt@grappa.test";

export const NETWORK_SLUG = "bahamut-test";
export const NETWORK_NICK = "vjt-grappa";
export const AUTOJOIN_CHANNELS = ["#bofh"];

const TOKEN_ENV_VAR = "E2E_VJT_TOKEN";

export default async function globalSetup(): Promise<void> {
  const result = await login(VJT_IDENTIFIER, VJT_PASSWORD);
  process.env[TOKEN_ENV_VAR] = result.token;
}

export function getSeededVjt(): SeededUser {
  const token = process.env[TOKEN_ENV_VAR];
  if (!token) {
    throw new Error(
      `getSeededVjt: ${TOKEN_ENV_VAR} not set. Did playwright globalSetup run?`,
    );
  }
  return {
    name: VJT_USER,
    password: VJT_PASSWORD,
    identifier: VJT_IDENTIFIER,
    token,
  };
}
