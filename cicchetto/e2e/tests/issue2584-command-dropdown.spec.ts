// issue 2584 — the `/` command menu over the compose box, asserted on what a
// person SEES in a real browser on the real stack. The unit tests
// (ComposeBoxCommandMenu.test.tsx) pin the same rules against the real compose
// store in jsdom; what only a browser can say is the rest of it: that the menu
// is laid out where a pointer can reach it (Playwright's click and tap both
// refuse a target something else covers), that the real keydown path drives
// Tab and Escape, that a tap keeps the focus in the composer, and that the
// counts the menu orders by really come back from the server to a SECOND
// device that never sent anything.
//
// Every test runs as its own freshly provisioned subject (fixtures/
// specSubject.ts), so the counts start EMPTY each run and the default order is
// what a new account sees — which is what makes the first assertion exact
// rather than "contains", and the spec repeat-each-able.

import type { Page } from "@playwright/test";
import {
  closeSettings,
  composeSend,
  composeTextarea,
  expectShellReady,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

const menu = (page: Page) => page.getByTestId("command-menu");
const entries = (page: Page) => menu(page).getByRole("option");
const entry = (page: Page, label: string) =>
  menu(page).getByRole("option", { name: label, exact: true });

// What a fresh account is offered with the default five entries (vjt's
// ruling, Q2 — lib/commandUsage.ts DEFAULT_COMMAND_ORDER).
const DEFAULT_FIVE = ["/join", "/msg", "/me", "/query", "/whois"];

async function openChannel(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}

test("issue 2584 — `/` offers the default commands; typing filters, Tab walks and marks them, Escape closes, a click picks", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await openChannel(page);
  const ta = composeTextarea(page);
  await ta.click();
  await expect(menu(page)).toHaveCount(0);

  await ta.fill("/");
  await expect(entries(page)).toHaveText(DEFAULT_FIVE);

  await ta.fill("/wh");
  await expect(entries(page)).toHaveText(["/whois", "/who", "/whowas"]);
  await expect(menu(page).locator('[aria-selected="true"]')).toHaveCount(0);

  // Tab walks the entries the menu shows, in its order, and the menu marks
  // the one in the box. The space is the command's: the arguments come next.
  await ta.press("Tab");
  await expect(ta).toHaveValue("/whois ");
  await expect(entry(page, "/whois")).toHaveAttribute("aria-selected", "true");
  await ta.press("Tab");
  await expect(ta).toHaveValue("/who ");
  await expect(entry(page, "/who")).toHaveAttribute("aria-selected", "true");
  await expect(entry(page, "/whois")).toHaveAttribute("aria-selected", "false");
  await expect(ta).toBeFocused();

  // Escape closes the menu and leaves the draft alone…
  await ta.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(ta).toHaveValue("/who ");
  // …until the draft changes. Also the positive control for the line above:
  // the page was alive and still able to show the menu.
  await ta.fill("/wh");
  await expect(entries(page)).toHaveText(["/whois", "/who", "/whowas"]);

  // A pointer pick: the command and its space, and the focus stays in the box.
  await entry(page, "/whowas").click();
  await expect(ta).toHaveValue("/whowas ");
  await expect(ta).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
});

test("issue 2584 — the menu settings are this device's: fewer entries, then off, and a reload keeps them", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await openChannel(page);
  const ta = composeTextarea(page);

  // The pre-state, in this very page: on, five entries.
  await ta.fill("/");
  await expect(entries(page)).toHaveText(DEFAULT_FIVE);
  await ta.fill("");

  await openSettingsSection(page, "display");
  await page.getByTestId("command-menu-entries-select").selectOption("3");
  await closeSettings(page);
  await ta.fill("/");
  await expect(entries(page)).toHaveText(["/join", "/msg", "/me"]);
  await ta.fill("");

  await openSettingsSection(page, "display");
  await expect(page.getByTestId("command-menu-toggle")).toBeChecked();
  await page.getByTestId("command-menu-toggle").uncheck();
  await closeSettings(page);

  // Off: no menu, and Tab completes no command either (one switch, both doors).
  await ta.fill("/wh");
  await ta.press("Tab");
  await expect(ta).toHaveValue("/wh");
  await expect(menu(page)).toHaveCount(0);

  // Remembered on this device: localStorage, read back at the next boot.
  await page.reload();
  await expectShellReady(page);
  await openChannel(page);
  await ta.fill("/");
  await expect(menu(page)).toHaveCount(0);
  // The positive control for both "nothing"s: the completion engine is alive
  // on this page, it simply has no commands to offer.
  const nick = specNick();
  await ta.fill(nick.slice(0, nick.length - 2));
  await ta.press("Tab");
  await expect(ta).toHaveValue(`${nick}: `);
});

test("issue 2584 — the most used commands come first, on every device of the account", async ({
  page,
  browser,
}) => {
  const vjt = specUser();
  const nick = specNick();
  await loginAs(page, vjt);
  await openChannel(page);
  const ta = composeTextarea(page);

  // Two of one, then one of another: the order the menu shows is by COUNT,
  // so the verb sent LAST must still come second.
  await composeSend(page, `/whois ${nick}`);
  await composeSend(page, `/whois ${nick}`);
  await composeSend(page, `/whowas ${nick}`);
  const counted = ["/whois", "/whowas", "/join", "/msg", "/me"];

  // The device that sent is current at once: the POST answers the whole map.
  await ta.fill("/");
  await expect(entries(page)).toHaveText(counted);
  await ta.fill("");

  // A second device of the same account, with its own (empty) localStorage:
  // nothing pushes the counts to it (vjt's ruling, Q3), it reads them at its
  // user-topic join. So what it shows came from the server, not from page A.
  const ctxB = await browser.newContext();
  try {
    const pageB = await ctxB.newPage();
    await loginAs(pageB, vjt);
    await expectShellReady(pageB);
    await openChannel(pageB);
    const taB = composeTextarea(pageB);
    await taB.fill("/");
    await expect(entries(pageB)).toHaveText(counted);
  } finally {
    await ctxB.close();
  }
});

test("@webkit @touch issue 2584 — a tap on an entry puts the command in the box and keeps the focus there", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await openChannel(page);
  const ta = composeTextarea(page);
  await ta.tap();
  await ta.fill("/wh");
  await expect(entries(page)).toHaveText(["/whois", "/who", "/whowas"]);

  // #59 — the entry cancels its mousedown, so the composer keeps the focus
  // (on a phone: the keyboard stays up for the arguments).
  await entry(page, "/whois").tap();
  await expect(ta).toHaveValue("/whois ");
  await expect(ta).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
  await expect
    .poll(() => ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([7, 7]);
});
