// #1336 — the per-spec subject's autojoin channel must be WORKER-SCOPED.
//
// `AUTOJOIN_CHANNELS` moved off the shared `#bofh` so that the three
// long-lived seeded users stop collecting a JOIN and a QUIT from every
// test that provisions a subject (measured: 42 rows over a 6-test pilot,
// 7.00 per test, all of them in scrollback no spec asked for).
//
// That cure is only correct while at most ONE per-spec subject is alive
// at a time. `playwright.config.ts` says `workers: 1`, and the channel
// name carries `TEST_PARALLEL_INDEX` so the guarantee survives a future
// `workers: N` instead of silently re-growing the residue in a channel
// shared by parallel subjects.
//
// This spec is the oracle for the derivation actually happening: the
// constant is evaluated at module scope, and if Playwright ever stops
// exporting the worker index there, the name degrades to the `setup`
// spelling and this goes red. Bare `@playwright/test` import on purpose
// — it reads a constant, so provisioning a subject for it would be
// paying for a session nobody uses.

import { expect, test } from "@playwright/test";
import { AUTOJOIN_CHANNELS } from "../fixtures/seedData";

test("#1336 — the per-spec autojoin channel is worker-scoped, not the shared #bofh", () => {
  expect(AUTOJOIN_CHANNELS).toHaveLength(1);
  // `\d+` and not `\d*`: the runner-process spelling (`#spec-wsetup`)
  // reaching a worker is the exact failure this guards.
  expect(AUTOJOIN_CHANNELS[0]).toMatch(/^#spec-w\d+$/);
});
