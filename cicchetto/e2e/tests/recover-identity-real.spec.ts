// #581 — "recover my identity", REAL-SERVICES full round-trip e2e (path A).
//
// The NON-HOLLOW companion to the server integration + cic unit tests. Drives
// the visitor recover flow through cicchetto against the LIVE stack —
// grappa-test → bahamut-test (the azzurra leaf) → azzurra-services
// (email-enabled) → mailpit — and proves an ACTUAL parked-on-a-held-nick
// visitor reclaims a registered nick via NickServ RECOVER → `+r`. Success is
// asserted on the VISIBLE modal outcome (D4), never an API return; no
// soft-assert accepts success-or-failure.
//
// ── THE STAGING (why each step) ───────────────────────────────────────────
// `recoverable` (the button gate + the /recover secret source) reads the
// PERSISTENT `(visitor_id, network_id)` credential; it is recoverable ONLY
// once that credential is `:nickserv_identify` + `password_encrypted` — the
// state a PRIOR `+r` commit (`Visitors.commit_identity`) leaves. Login alone
// does NOT persist it (a fresh first-login visitor gets an ANON credential +
// an in-memory `with_login_identify` plan override — the button correctly
// hides for it; test 1 proves exactly that). So the positive path must FIRST
// make the visitor reach `+r` once (nick free).
//
// The MANUAL #581 recover serves a scenario DISJOINT from the automatic
// GhostRecovery, split by connection phase (see DESIGN_NOTES + the plan
// FINDING): auto owns the PRE-001 window (a held nick earns a 433 BEFORE 001
// while `pending_password` is set → server auto NICK_→GHOST→IDENTIFY→+r,
// server.ex:2876); the manual 🔑 owns POST-001 (already connected, on a
// non-`+r` nick, target held → its 433 handler at server.ex:2862 sits ABOVE
// ghost). A reconnect-with-held-nick staging can NOT surface the manual button
// — auto-ghost reclaims it PRE-001 (measured: it timed out that way,
// 2026-08-01). To reach POST-001 non-`+r` DETERMINISTICALLY the visitor does a
// voluntary `/nick` (clears `+r` per bahamut m_nick.c, no ghost re-fire). That
// only reveals the button because the companion EventRouter fix mirrors
// bahamut's SILENT `+r`-strip on a self-rename — pre-fix grappa kept a phantom
// `+r` and the button stayed hidden (that IS the state bug this e2e surfaced).
//
//   1. IrcPeer registers the (stamped) recover nick with the real NickServ
//      emailed AUTH code via mailpit → AUTH → `+r`), then DISCONNECTS — the
//      nick is now FREE but REGISTERED (password known).
//   2. The visitor logs in WITH that password (`loginVisitor`) → grappa
//      connects to the FREE nick → built-in IDENTIFY → `+r` → `commit_identity`
//      persists the `:nickserv_identify` credential → `recoverable` flips true.
//      (Barrier: poll GET /me until `recoverable === true`.) The button is
//      HIDDEN here — the visitor is `+r`.
//   3. The visitor voluntarily `/nick`s to a free Guest nick (composeSend from
//      the $server window) → bahamut strips `+r` (silent), grappa MIRRORS it
//      (the fix) → the visitor is now connected, POST-001, NON-`+r`, and
//      the recover nick is FREE again. `recoverable` stays true → the 🔑 button
//      APPEARS (the POST-001 barrier).
//   4. IrcPeer RECONNECTS + IDENTIFYs the recover nick (a stable, legitimate hold).
//   5. Click 🔑 Recover → the server-driven RecoverModal → NICK(433, held) →
//      RECOVER (services free IrcPeer's hold — SPIKE-PROVEN 2026-07-31, FREED)
//      → settle → NICK + IDENTIFY → `+r` → the modal shows terminal SUCCESS.
//
// ── EMAIL DOMAIN (source-verified, load-bearing) ──────────────────────────
// azzurra/services `validate_email` is a HARDCODED ICANN-TLD allowlist (no
// DNS). `.test` is rejected; use `example.com` (RFC-2606). msmtp relays ALL
// mail to mailpit regardless of domain → fully hermetic. (Same note as
// registration-wizard-real.spec.ts.)
//
// ── MEASURED on the lane (2026-08-01) ─────────────────────────────────────
//  * (f) step-1 register reached real `+r` + "Password accepted" on `azzurra`
//    → email + services work on the visitor network (shares the bahamut-test
//    hub with `azzurra-reg`, which the wizard spec emails).
//  * (c) `waitForRecoverable(true)` passed post-login → the `+r` commit
//    persists the `:nickserv_identify` credential; no stubborn post-QUIT hold.
// The obsolete park/reconnect staging (which auto-ghost reclaimed PRE-001) is
// GONE — the voluntary-`/nick` path reaches POST-001 without touching the
// network connection_state, so no visitor-token PATCH is needed here.
//
// ── RE-RUN NOTE ───────────────────────────────────────────────────────────
// The recover nick + its registration email are STAMPED per test run, because
// a NickServ registration is once-per-nick-per-services-container: a fixed
// nick made the second run on a persistent testnet answer "already
// registered", which resolves the register barrier instantly and then hangs
// the mail wait — so `--repeat-each`, the iso-rerun discipline this project
// mandates for flake triage (docs/TESTING.md), could not be used on the one
// spec that needed it (#623). Stamped, every iteration registers its own nick
// against the same container and the spec is re-runnable N times on ONE
// stack.

import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import {
  composeSend,
  expectShellReady,
  selectChannel,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import {
  GRAPPA_BASE_URL,
  loginVisitor,
  mintVisitor,
  reapVisitors,
} from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { awaitMail, extractFromMail, resetMailpit } from "../fixtures/mailpit";
import { IrcPeer } from "../fixtures/ircClient";

// Boot cic as a visitor (local per-spec helper — the established pattern; each
// visitor spec inlines its own). Seeds the two auth localStorage keys the SPA
// reads at module init, navigates, and waits for the shell + user-topic to be
// live so subsequent home-row assertions see settled state.
async function bootVisitor(
  browser: Browser,
  visitor: { id: string; nick: string; token: string },
): Promise<{ ctx: Awaited<ReturnType<Browser["newContext"]>>; page: import("@playwright/test").Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id, nick: visitor.nick })] as const,
  );
  await page.goto("/");
  await expectShellReady(page);
  await waitForUserTopicReady(page, `visitor:${visitor.id}`);
  return { ctx, page };
}

const NETWORK_SLUG = "azzurra"; // visitor_enabled + real azzurra-services (bahamut-test hub)
const RECOVER_PASSWORD = "recidpw1"; // 5–32 chars (NickServ floor)
const AUTH_CODE_RE = /AUTH (\d+)/;

// Poll GET /me until the `NETWORK_SLUG` home row's `recoverable` flag equals
// `expected`. `recoverable` = `Credential.has_nickserv_secret?/1` server-side,
// which flips true ONLY after the `+r` commit persists the `:nickserv_identify`
// credential — the deterministic barrier for "the credential is now
// recoverable" (step 2) and the honest server-side proof of the reverse
// (an anon credential is NOT recoverable).
async function waitForRecoverable(
  token: string,
  slug: string,
  expected: boolean,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: boolean | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${GRAPPA_BASE_URL}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      // GET /me → `{kind, …, home_data: {networks: [home_network_row], …}}`
      // (me_json.ex). `recoverable` lives on each home_data.networks row.
      const body = (await res.json()) as {
        home_data?: { networks: Array<{ slug: string; recoverable: boolean }> };
      };
      const row = body.home_data?.networks.find((n) => n.slug === slug);
      last = row?.recoverable;
      if (last === expected) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForRecoverable(${slug}): never reached recoverable=${expected} (last=${last})`,
  );
}

test.describe("#581 recover-identity (real services)", () => {
  // Reverse (deterministic, no services): a first-login visitor's credential
  // is anon, so `recoverable` is false and the 🔑 button is ABSENT. Proves
  // `recoverable` is NOT always-true — the gate genuinely gates (orchestrator
  // ask, 2026-08-01). Fast: pure anon mint, no register round-trip.
  test("first-login (anon credential) → recoverable is false and the 🔑 button is absent", async ({
    browser,
  }) => {
    const admin = getSeededAdmin();
    const stamp = Date.now();
    let visitor: Awaited<ReturnType<typeof mintVisitor>> | null = null;
    let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;

    try {
      visitor = await mintVisitor(`recno-${stamp % 100000}`);

      // Server-side proof: the anon credential is NOT recoverable.
      await waitForRecoverable(visitor.token, visitor.network_slug, false, 15_000);

      const booted = await bootVisitor(browser, visitor);
      ctx = booted.ctx;
      const page = booted.page;

      await page.locator(".sidebar-home-btn").click();
      // The launcher never renders for an anon (non-recoverable) credential.
      await expect(
        page.getByTestId(`home-recover-identity-${visitor.network_slug}`),
      ).toHaveCount(0);
    } finally {
      if (ctx) await ctx.close();
      await reapVisitors(admin.token, visitor?.id);
    }
  });

  // Positive (real services): the POST-001 /nick staging above.
  test("a returning visitor on a Guest nick recovers a held registered nick via RECOVER → +r", async ({
    browser,
  }) => {
    // Register round-trip (~45s) + login + /nick + recover (~15s).
    test.setTimeout(150_000);

    const admin = getSeededAdmin();
    const stamp = Date.now();
    const guestNick = `recguest${stamp % 100000}`; // free + unique per run
    // Stamped so the registration is fresh on a persistent testnet too (see
    // the RE-RUN NOTE): NickServ registers a nick exactly once per container.
    const recoverNick = `recid${stamp % 100000}`;
    const regEmail = `${recoverNick}@example.com`; // valid TLD (see EMAIL DOMAIN note)
    let visitor: Awaited<ReturnType<typeof loginVisitor>> | null = null;
    let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;
    const peers: IrcPeer[] = [];

    try {
      await resetMailpit();

      // ── Step 1: register the stamped nick with the REAL NickServ, free it ──
      const registrar = await IrcPeer.connect({ nick: recoverNick });
      peers.push(registrar);
      await registrar.nickservRegister(RECOVER_PASSWORD, regEmail);
      const mail = await awaitMail(regEmail, { timeoutMs: 45_000 });
      const code = extractFromMail(mail, AUTH_CODE_RE);
      await registrar.nickservAuth(code); // → +r on the registrar
      await registrar.disconnect("free the nick for the visitor"); // nick FREE, still REGISTERED
      peers.pop();

      // ── Step 2: visitor logs in WITH the password → connects free → +r → commit ──
      visitor = await loginVisitor(recoverNick, RECOVER_PASSWORD, NETWORK_SLUG);
      // The +r commit persists the :nickserv_identify credential → recoverable.
      await waitForRecoverable(visitor.token, NETWORK_SLUG, true);

      const booted = await bootVisitor(browser, visitor);
      ctx = booted.ctx;
      const page = booted.page;

      // Button HIDDEN while the visitor is +r (identified) — canRecover's !+r half.
      await page.locator(".sidebar-home-btn").click();
      await expect(page.getByTestId(`home-recover-identity-${NETWORK_SLUG}`)).toHaveCount(0);

      // ── Step 3: voluntary /nick to a free Guest (from $server) → +r cleared ──
      // Reaches POST-001, connected, non-+r (the manual-recover scenario) WITHOUT
      // a reconnect (which auto-ghost would reclaim PRE-001). bahamut strips +r
      // silently on the rename; the EventRouter fix mirrors it so cic's
      // canRecover() flips true. The credential is :nickserv_identify, so its
      // nick is HELD at the recover nick (update_visitor_credential_nick is
      // anon-gated → :held_identified) — recover still targets that nick.
      await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });
      await composeSend(page, `/nick ${guestNick}`);

      // Button REAPPEARS now that the visitor is no longer +r (on a Guest) and
      // the credential is still recoverable — the POST-001 barrier.
      await page.locator(".sidebar-home-btn").click();
      const recoverBtn = page.getByTestId(`home-recover-identity-${NETWORK_SLUG}`);
      await expect(recoverBtn).toBeVisible({ timeout: 30_000 });

      // ── Step 4: IrcPeer takes + IDENTIFYs the recover nick (free) → 433 on recover ──
      const holder = await IrcPeer.connect({ nick: recoverNick });
      peers.push(holder);
      await holder.nickservIdentify(RECOVER_PASSWORD);

      // ── Step 5: 🔑 Recover → NICK(433) → RECOVER frees the hold → +r → SUCCESS ──
      await recoverBtn.click();

      const modal = page.getByTestId("recover-modal");
      await expect(modal).toBeVisible({ timeout: 10_000 });

      // Visible progress: the recover step reaches ok at least once (the modal
      // accumulates server-pushed steps; the recover verb is the reclaim path).
      await expect(
        modal.locator('[data-testid="recover-modal-step"][data-step="recover"]'),
      ).toBeVisible({ timeout: 20_000 });

      // THE SHIP GATE (D4): the VISIBLE terminal success — the nick genuinely
      // reached `+r` after RECOVER freed the holder. No API return, no
      // success-or-failure soft-assert.
      await expect(page.getByTestId("recover-modal-success")).toBeVisible({ timeout: 30_000 });
    } finally {
      for (const peer of peers) await peer.disconnect("e2e cleanup").catch(() => {});
      if (ctx) await ctx.close();
      await reapVisitors(admin.token, visitor?.id);
    }
  });
});
