// #793 — a shareable invite link, `irc.sindro.me/<network>/<channel>`, is a
// URL you can paste to a normal person: they click it, they are ASKED, and
// they land in the channel.
//
// What is proven here is the user-visible chain, end to end against the live
// bahamut-test leaf, not the existence of a parser:
//   1. Opening the app AT the invite path pops the shared ConfirmModal naming
//      the channel; confirming JOINs it and switches to the window. The
//      address bar is left clean, so a refresh does not re-fire the invite.
//   2. An invite to a channel we are already in switches straight there with
//      NO modal (#648's rule: asking to join an open window is noise).
//   3. An invite naming a network this account has not bound joins nothing
//      and says so — the branch #793 leaves open (cross-user network
//      identity) must be a visible dead end, never a silent one.
//
// Before #793 the SPA had no route for a two-segment path at all: the server
// served index.html (#399) and the router matched nothing, so the link
// rendered a blank page. That is what test 1 fails on if the boot reader
// stops rewriting the URL.

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalYes,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  joinChannel,
  listChannelNames,
  partChannel,
  type SeededUser,
} from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

// Lowercase throughout: raw == ASCII-folded, so the sidebar window key (the
// folded key IS the display) equals the spelling asserted on. The raw-vs-
// folded split of the invite path itself is pinned by the inviteLink unit
// test (`#BoFH`), which is the cheaper place for a casing matrix.
const freshChannel = (label: string) => `#i793${label}-${crypto.randomUUID().slice(0, 6)}`;

// The link carries the channel WITHOUT its `#`: a literal `#` in a URL is the
// fragment delimiter and would never reach the server. The bare spelling is
// the one a human pastes, and the parser implies the sigil.
const invitePath = (networkSlug: string, channel: string) =>
  `/${networkSlug}/${channel.replace(/^#/, "")}`;

// Auth is pre-seeded the way `loginAs` does it, but the navigation target is
// the invite path rather than `/` — `loginAs` always gotos the root.
async function openInvite(page: Page, vjt: SeededUser, path: string): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [vjt.token, vjt.subjectJson] as const,
  );
  await page.goto(path);
}

test("an invite link asks, then joins and switches (#793)", async ({ page }) => {
  const vjt = getSeededVjt();
  const target = freshChannel("join");

  await openInvite(page, vjt, invitePath(NETWORK_SLUG, target));

  // Discriminating probe: the invite reader sets this only after it has
  // ROUTED a parsed target, so the assertions below cannot pass off the back
  // of an unrelated session-restore selection.
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  // The consent gate. A URL must never join anybody silently.
  await expect(confirmModal(page)).toBeVisible({ timeout: 10_000 });
  await expect(confirmModalBody(page)).toHaveText(`Join ${target}?`);

  // Address bar already clean — the invite is spent, a refresh re-fires
  // nothing. Asserted BEFORE the confirm so it is the reader being tested,
  // not some later navigation.
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");

  await confirmModalYes(page);

  try {
    await expect(sidebarWindow(page, NETWORK_SLUG, target)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
    // Count-0, not not-visible: an absent node satisfies toBeVisible's
    // negation for the wrong reason.
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await partChannel(vjt.token, NETWORK_SLUG, target);
  }
});

test("an invite to a channel we are already in switches with NO modal (#793)", async ({ page }) => {
  const vjt = getSeededVjt();
  const already = freshChannel("have");

  // The PRECONDITION is "already in the channel", so it has to be true before
  // the link is opened — not merely requested. `joinChannel` returns when the
  // POST is accepted; the channel appears in the list cic reads at boot once
  // the upstream JOIN lands. Waiting on the list makes this a test of the
  // invite's already-in branch instead of a race against the join.
  await joinChannel(vjt.token, NETWORK_SLUG, already);
  await expect
    .poll(() => listChannelNames(vjt.token, NETWORK_SLUG), { timeout: 20_000 })
    .toContain(already);

  try {
    await openInvite(page, vjt, invitePath(NETWORK_SLUG, already));
    await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
      timeout: 15_000,
    });

    await expect(sidebarWindow(page, NETWORK_SLUG, already)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await partChannel(vjt.token, NETWORK_SLUG, already);
  }
});

test("an invite for an unbound network joins nothing and says so (#793)", async ({ page }) => {
  const vjt = getSeededVjt();

  await openInvite(page, vjt, invitePath("nowhere-bound", "somechannel"));
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  await expect(page.locator(".toast-stack .toast")).toContainText("nowhere-bound", {
    timeout: 10_000,
  });
  // No consent was asked for, because there is nothing to consent to.
  await expect(confirmModal(page)).toHaveCount(0);
});
