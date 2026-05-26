import { test as base } from "@playwright/test";
import { resetSubject } from "./grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG, VJT_USER } from "./seedData";

// E2E-ROBUSTNESS bucket D — wrapped Playwright `test` fixture that
// auto-resets vjt's grappa-side state after every test. Replaces the
// per-spec `test.afterEach(() => resetSubject(...))` boilerplate so
// future spec authors get cascade-prevention for free.
//
// Specs that touch the seeded `vjt` user MUST import `test` from THIS
// module instead of `@playwright/test`. Specs that target other seed
// users (admin-vjt, m9b-test, m9b-victim) keep the bare
// `@playwright/test` import — the reset is vjt-scoped, not global.
//
// Wire: `_vjtReset` is an `auto: true` test-scoped fixture whose
// teardown phase fires after EVERY `test()` body in any file that
// imports `test` from this module. No per-spec wiring required.
//
// `baselineAutojoin` is the seed-time autojoin contract per network
// slug — the fixture passes it through so the reset restores
// `cred.autojoin_channels` to the seeded list every iteration. cic's
// PART verb (DELETE /networks/.../channels) strips operator-config
// autojoin permanently; UX-1, m9-part-x-click, cp15-b6 exercise
// this. Without restoration, every reset after those specs sees an
// empty autojoin list and `#bofh` never re-JOINs.
//
// `baselineSeed` is the per-channel scrollback seed contract —
// truncate to zero rows then re-seed `seedCount` synthetic privmsg
// rows. Mirrors the seeder's compose-time
// `mix grappa.seed_scrollback --count 200 --sender seed-bot` so
// every spec starts with EXACTLY the same scrollback baseline.
// Without this, accumulated rows from prior specs flip
// scroll-density-sensitive assertions in later specs (visible-tail,
// marker placement, cursor-advance gates).
//
// See `lib/grappa/test_support/subject_reset.ex` for the orchestrator
// + the `POST /admin/test/reset-subject` endpoint
// (compile-gated to dev/test Mix envs).
const SEED_COUNT = 200;

export const test = base.extend<{ _vjtReset: void }>({
  _vjtReset: [
    async ({}, use) => {
      await use();
      const admin = getSeededAdmin();
      await resetSubject(
        admin.token,
        VJT_USER,
        { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
        {
          [NETWORK_SLUG]: AUTOJOIN_CHANNELS.map((name) => ({
            name,
            seedCount: SEED_COUNT,
            seedSender: "seed-bot",
          })),
        },
      );
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
