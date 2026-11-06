// #1262 — channel status-prefix MODE rows (the churn) fold into the denoise
// filter; own-nick mode rows on `$server` do not, and since issue 2176 neither
// do the STRUCTURAL channel modes (last test in this file).
//
// `:mode` was carved OUT of the suppressed set by #458 on the rule "the broad
// presence/control kinds carry operator-relevant signal and MUST stay
// visible". vjt withdrew that rule on 2026-08-13, so `:mode` is now the fifth
// plain kind in `Grappa.Scrollback.Message.suppressed_presence_kinds/0` and in
// cic's `SUPPRESSED_PRESENCE_KINDS`.
//
// ## What this e2e owns vs what the unit tests own
//
// The SET membership is pinned in `test/grappa/scrollback/message_test.exs` and
// `src/__tests__/presenceFilter.test.ts`, and the two languages are held equal
// by the parser gate in `test/grappa/presence_filter_test.exs`. The `$server`
// resolve-to-SHOW rule is pinned in
// `test/grappa/presence_filter/resolver_test.exs`. None of those can see the
// VISIBLE outcome, which is what this spec owns:
//
//   1. a channel MODE row renders, then DISAPPEARS the moment the channel is
//      denoised (the cic render filter), and
//   2. it is still gone after a RELOAD — i.e. the SERVER omitted it from the
//      cold-load page, not merely cic hiding it. This is the half that would
//      regress if only one side of the mirror moved; and
//   3. the own-nick `$server` mode row SURVIVES the same reload, because
//      `$server` has no member count and resolves to SHOW.
//
// A content row rides along throughout as the load witness: it proves the
// page is populated, so "0 mode rows" means folded rather than "nothing
// loaded yet" (an empty pane would satisfy the mode assertion vacuously).
//
// ## 🔴 The churn exemplar MOVED from `+m` to `-o` (issue 2176)
//
// This spec used to set `/mode <chan> +m` as its specimen of "a channel MODE
// row". Issue 2176 reclassified `+m`: a mode that changes the CHANNEL (`+b`,
// `+k`, `+l`, `+m`, `+i`, `+t`, `+n`, `+s`) is STRUCTURAL and stays visible
// while denoised; only a member's status prefix (`+o`/`-o`, `+v`, and whatever
// else this network put in `PREFIX=`) is the churn this filter folds.
//
// So the CLAIM below is untouched and still gated — a channel MODE row that is
// churn folds, server-side too. What changed is the SPECIMEN, because the old
// one stopped being churn. This is deliberate, not an assert softened to turn a
// red green: `+m` now has its own test at the bottom of this file asserting the
// OPPOSITE outcome, and removing the structural/churn distinction kills that
// one. Read the two together.
//
// ## Why the spec creates its own channel
//
// `/join` on a fresh name makes the seeded user the channel creator, hence
// chanop — the same trick #240 uses for the mode modal. On a shared autojoin
// channel the user may not be op, and bahamut only echoes a MODE it actually
// applied, so a non-op attempt would hang to timeout rather than fail
// (feedback: the witness must be SERVED by the ircd).
//
// That precondition is also WHY the churn specimen is `-o` on our own nick
// rather than `+v`: being op is a fact this spec already establishes and
// depends on, so deopping ourselves is guaranteed to be applied and echoed for
// exactly the same reason the old `+m` was. Nothing new is assumed about how
// bahamut treats a voice grant to an existing op. It goes LAST — after it we
// are no longer op, so no further MODE would be applied.
//
// Anti-hollow-green: `/umode -i` in `finally` restores the shared seeded
// session's umode set so sibling specs do not inherit `+i` (mirrors #229).
//
// Desktop project (untagged → chromium; NO @webkit).

import type { Page } from "@playwright/test";
import { composeSend, loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

// A ban mask is `!`, `*`, `@` and dots — every one of them a regex
// metacharacter. Interpolating it raw would build a pattern that matches
// something other than the mask, which is the quiet way an e2e stops testing
// what its name says.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A MODE row's `body` is NULL on the wire — measured, not assumed:
// `EventRouter` persists it as `build_persist(…, nil, %{modes:, args:})`, so
// the token and its arguments live in `meta`. Asserting on `body` would
// compare `undefined` and pass for the wrong reason.
type ServedRow = { id: number; kind: string; meta?: { modes?: string; args?: string[] } };

// THE SERVER HALF of both tests reads the RESPONSE BODY, not the pane.
// Measured, because the first shape of the #1262 arm did the latter and was
// VACUOUS: with only `message.ex` reverted and cic's own filter intact, the
// render filter hides the row the server still sends, so the pane shows 0
// either way and the spec passed with the server defect fully present. A
// server-only mutant survived it; that is what promoted it from a DOM count
// to a wire assertion.
//
// Watches every `GET .../channels/<channel>/messages` the server answers from
// now on, and hands back the rows it served, ONCE EACH, by id. The cold load
// issues more than one GET for a channel (measured: a first shape that awaited
// one response read an array with no privmsg in it), and which one carries the
// rows is not something these specs should pin, so the subject is the union of
// what was served. A union, not a concatenation (issue 2328): cic has been
// measured sending the SAME `?after=<cursor>&limit=200` twice, 20 ms apart,
// after one reload (CI, PR 2565). Both answers carried the `+b` row once, and
// summing them counted that one row twice. Rows are deduped by id; two
// DISTINCT rows still count as two.
//
// The path must be ANCHORED, not `includes`-matched: the cold load also
// issues `/messages/count`, whose URL contains `/messages` and whose body is
// `{count: N}` (measured: a loose predicate matched it first and the arm died
// on a TypeError). The page body itself is a BARE ARRAY (api.ts's
// `fetchMessages`), not an envelope.
//
// The reader awaits the body of every response seen by the time it is called:
// the DOM barrier the tests take first proves cic has the rows, not that this
// side has parsed them.
function watchServedRows(page: Page, channel: string): () => Promise<ServedRow[]> {
  const bodies: Promise<ServedRow[]>[] = [];
  page.on("response", (r) => {
    if (
      r.request().method() !== "GET" ||
      r.status() !== 200 ||
      !new URL(r.url()).pathname.endsWith(`/channels/${encodeURIComponent(channel)}/messages`)
    ) {
      return;
    }
    bodies.push(
      r.json().then(
        (body) => (Array.isArray(body) ? (body as ServedRow[]) : []),
        () => [],
      ),
    );
  });
  return async () => {
    const byId = new Map<number, ServedRow>();
    for (const row of (await Promise.all(bodies)).flat()) byId.set(row.id, row);
    return [...byId.values()];
  };
}

test("#1262 — a channel MODE row folds when denoised (server-side too), the $server umode row stays", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = `#t1262-${Date.now()}`;
  const content = `issue1262-content-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before
  // issuing the /join (mirrors #240 / issue216 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // --- the $server half: an own-nick umode row -------------------------
    // Issued BEFORE the channel work so it is comfortably persisted by the
    // time the reload below re-reads $server from the server.
    await composeSend(page, "/umode +i");

    // --- a channel where we are op --------------------------------------
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // Content witness first, then the MODE. Same socket ⇒ ordered.
    await composeSend(page, content);
    await composeSend(page, `/mode ${channel} -o ${specNick()}`);

    const contentRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: content });
    const modeRows = page.locator('[data-testid="scrollback-line"][data-kind="mode"]');

    // Baseline: unset pref on a 1-member channel → presence SHOWN, so the
    // mode row renders. Without this the "0 rows" below proves nothing.
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(modeRows.first()).toBeVisible({ timeout: 15_000 });

    // --- denoise: the render filter drops it -----------------------------
    // Await the persist PUT before reloading — the cold-load resolves
    // hide_presence from the PERSISTED pref, so an in-flight PUT would race
    // an unfiltered fetch (the #458 lesson).
    await openRailMenu(page);
    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    const hidePut = page.waitForResponse(
      (r) =>
        r.url().includes("/me/settings/display-prefs") && r.request().method() === "PUT" && r.ok(),
    );
    await toggle.click();
    await hidePut;

    await expect(modeRows).toHaveCount(0, { timeout: 10_000 });
    await expect(contentRow).toHaveCount(1); // a filter, not a blanket drop

    // --- THE SERVER HALF: the cold-load PAGE arrives without the mode row -
    // Read off the wire (`watchServedRows`). The pane count below stays as
    // the operator-visible half, but it is the JSON that speaks for the
    // server.
    const readServed = watchServedRows(page, channel);

    await page.reload();
    await selectChannel(page, NETWORK_SLUG, channel, { awaitWsReady: false });

    // DOM barrier FIRST: the content row being back is the durable signal
    // that the cold load has actually landed. Reading the collected pages
    // before it would race the fetches still in flight.
    await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
    await expect(modeRows).toHaveCount(0);

    const served = await readServed();
    // Non-vacuity: no page answered, or pages that carried nothing, would
    // satisfy "no mode row" for the wrong reason. The content row on the wire
    // rules out both.
    expect(served.some((m) => m.kind === "privmsg")).toBe(true);
    expect(served.filter((m) => m.kind === "mode")).toEqual([]);

    // --- $server is NOT denoised by the channel's pin ---------------------
    // The pin is per-channel (`"<slug> <channel>"`), and `$server` has no
    // member count, so `PresenceFilter.hidden?/2` reads the unknowable count
    // as SHOW. The own-nick `+i` row must therefore survive the same
    // cold-load that just dropped the channel's mode row — this is the
    // #154(b) confirmation the operator relies on.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
    const serverModeRows = page.locator('[data-testid="scrollback-line"][data-kind="mode"]');
    await expect(serverModeRows.first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await composeSend(page, "/umode -i").catch(() => {});
  }
});

// issue 2176 — the other side of the same rule, and the reason the specimen
// above had to move. A STRUCTURAL channel mode (`+b`, the one vjt's ruling
// names) is exempt from the denoise per-ROW: the server tags it
// `meta.structural` at write time and both filters honour the tag.
//
// The RELOAD half is not decoration. It is the #458 invariant — REST history
// and the live tail must agree on the same channel — and it is the arm that
// catches a one-sided fix: tag the row but forget the server's history filter
// and the ban is visible in the tail and gone on page-up, which is the bug
// #2176 exists to kill wearing a different hat.
//
// Anti-vacuity mirrors the churn test: a content row proves the pane and the
// served page are populated, so "1 mode row" cannot be satisfied by an empty
// load, and the churn assertion inside this same denoised channel proves the
// denoise is actually ON — without it a broken toggle would show the ban for
// the wrong reason.
test("#2176 — a structural channel MODE row survives the denoise and the reload", async ({
  page,
}) => {
  const vjt = specUser();
  const channel = `#t2176-${Date.now()}`;
  const content = `issue2176-content-${Date.now()}`;
  const banMask = "nobody!*@structural.invalid";

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  await composeSend(page, `/join ${channel}`);
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: channel }),
  ).toHaveCount(1, { timeout: 15_000 });
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

  // Content witness, then the STRUCTURAL mode, then the CHURN mode. The churn
  // goes last for the same reason as in the test above: `-o` costs us op.
  await composeSend(page, content);
  await composeSend(page, `/mode ${channel} +b ${banMask}`);
  await composeSend(page, `/mode ${channel} -o ${specNick()}`);

  const contentRow = page
    .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
    .filter({ hasText: content });
  const modeRows = page.locator('[data-testid="scrollback-line"][data-kind="mode"]');
  // Anchored on `sets mode <token> `, not on a bare substring: the ban MASK
  // contains letters, and a loose `"-o"` match would be satisfied by any row
  // whose args happen to spell it.
  const banRow = modeRows.filter({ hasText: new RegExp(`sets mode \\+b ${escapeRe(banMask)}`) });
  const churnRow = modeRows.filter({ hasText: new RegExp(`sets mode -o ${specNick()}\\b`) });

  await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
  await expect(banRow).toHaveCount(1, { timeout: 15_000 });
  await expect(churnRow).toHaveCount(1, { timeout: 15_000 });

  // --- denoise: the ban stays, the churn goes ---------------------------
  await openRailMenu(page);
  const toggle = page.locator('[data-testid="presence-toggle"]');
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  const hidePut = page.waitForResponse(
    (r) =>
      r.url().includes("/me/settings/display-prefs") && r.request().method() === "PUT" && r.ok(),
  );
  await toggle.click();
  await hidePut;

  // The churn disappearing is the proof the denoise is ON. Assert it FIRST:
  // if the toggle silently did nothing, the ban assertion below would pass
  // for the wrong reason and this spec would be a mirror.
  await expect(churnRow).toHaveCount(0, { timeout: 10_000 });
  await expect(banRow).toHaveCount(1);
  await expect(contentRow).toHaveCount(1);

  // --- THE SERVER HALF: the cold-load PAGE still carries the ban --------
  // Same wire-level assertion as the churn test, and for the same measured
  // reason: a DOM-only check passes while the server-side filter is wrong,
  // because cic's render filter would be honouring the tag on its own.
  const readServed = watchServedRows(page, channel);

  await page.reload();
  await selectChannel(page, NETWORK_SLUG, channel, { awaitWsReady: false });

  await expect(contentRow).toHaveCount(1, { timeout: 15_000 });
  await expect(banRow).toHaveCount(1);
  await expect(churnRow).toHaveCount(0);

  const served = await readServed();
  expect(served.some((m) => m.kind === "privmsg")).toBe(true);
  // The server SERVED the ban row and WITHHELD the churn one — the two
  // halves of the split, read off the wire rather than off the pane.
  const servedModes = served.filter((m) => m.kind === "mode");
  expect(servedModes.filter((m) => m.meta?.modes === "+b")).toHaveLength(1);
  expect(servedModes.filter((m) => m.meta?.modes === "-o")).toEqual([]);
});
