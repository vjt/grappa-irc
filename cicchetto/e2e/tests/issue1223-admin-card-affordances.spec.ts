// #1223 — what an admin row card does on a phone, once #1157 turned rows
// into cards.
//
// vjt, dogfooding staging on an iPhone: *"abbiamo tap target solo sul testo
// quando invece dovrebbe esser tutta l'area, parlo ad es dei nomi visitor"*
// and *"poi abbiamo quest'idiozia di mostrare colonne già mostrate"*.
// Separate defects behind those readings, all of them layout, all therefore
// invisible to jsdom (`feedback_cicchetto_browser_smoke`) and to every
// vitest suite that mounts these components:
//
//   2. `.adm-row-expand` puts the 44px `--tap-min` floor on HEIGHT only and
//      sizes its box with `inline-flex`, so the door to the row's detail is
//      the caret + badge + nick run and the rest of the card's heading is
//      dead space that looks tappable. Asserted by TAPPING that dead space
//      and requiring the panel to open — the visible outcome, not the
//      declarations that produce it.
//
//   3. `.adm-facts` sizes its label track from the LONGEST label, so on a
//      393px screen the value track keeps well under half the width and
//      wraps timestamps over several lines. Asserted as the value track
//      taking the panel's full width, with the label above it.
//
//   1. the detail panel repeats fields the card already shows. vjt ruled the
//      fork on 2026-08-11 — *"1223 punto 1: direi drop no?"* — so the columns
//      really leave the card and the panel stays the only place they live.
//
//      Two defects share that symptom, and only ONE of them is in this file.
//      The `.adm-col-detail` specificity failure (Users, Credentials) is a
//      question about what is PAINTED, invisible to jsdom, so it is asserted
//      here. The Sessions repeat is JSX — `detailFacts` carried a `network`
//      fact while the identity cell printed the slug at every width, desktop
//      included — which vitest sees perfectly well and
//      `AdminSessionsTab.test.tsx` pins. Bringing it here too would buy a
//      slower copy of a test that already exists.
//
//      Also asserted here: the 769-899 BAND. The console's card regime starts
//      at 900px and `isMobile()` is 768px, so a fix that only raised the CSS
//      selector would have made that band strictly worse — columns gone,
//      `AdminRowName` still a plain span, no door to the panel they went
//      into. That is a real-browser claim as much as the drop is.
//
// The desktop test is the counter-claim, and it is why item 3's fix is a
// `@container` rule rather than a blanket single column: at a width where two
// columns fit, two columns are what the operator gets. Without it, collapsing
// unconditionally would pass.
//
// Sessions is the tab under test because its disclosure is `alwaysOpenable`
// (#1157), so the SAME control can be measured at both widths. The button is
// `AdminRowName`, which every tab routes identity through.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, the EXEMPT shape.

import type { Locator, Page } from "@playwright/test";
import { adminSessionRowKey, expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// admin-vjt has no network bind, so `loginAs`'s network-section shell-ready
// selector would time out. Same shape as #1073 / m7-admin-gate / m11-events.
async function adminLogin(page: Page): Promise<void> {
  const seed = getSeededAdmin();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expectShellReady(page);
}

async function openSessionsTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

async function openUsersTab(page: Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-users").click();
  await expect(page.getByTestId("admin-users-table")).toBeVisible({ timeout: 10_000 });
}

// The card's cells that are actually PAINTED. `getClientRects()` rather than
// a computed-style read: a `display: none` cell has no boxes, which is the
// property under test, and it costs nothing on WebKit (where reading computed
// style has bitten this suite before).
async function paintedCellTexts(row: Locator): Promise<string[]> {
  return row.locator("td").evaluateAll((tds) =>
    tds
      .filter((td) => td.getClientRects().length > 0)
      .map((td) => (td.textContent ?? "").trim())
      .filter((text) => text !== ""),
  );
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null)
    throw new Error(`${what} has no layout box — the markup or the classes drifted`);
  return box;
}

test("#1223 @webkit on a phone the whole card heading opens the row, not just the nick", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`tap1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    const row = page.getByTestId(`admin-session-row-${key}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();

    // Pre-state, asserted rather than assumed: the panel is CLOSED, so the
    // tap below is what opens it and not a coincidence of a panel already on
    // screen from a previous step.
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toHaveCount(0);

    const heading = row.locator("td.adm-cell-title");
    const glyphs = row.locator(".admin-session-lines");
    const headingBox = await boxOf(heading, "the card heading cell");
    const glyphBox = await boxOf(glyphs, "the identity's glyph run");

    // The probe point: the heading's right end, past everything that is
    // drawn. If the glyph run happens to fill the heading there is no dead
    // space to aim at and the tap would prove nothing — fail loudly rather
    // than pass vacuously.
    const tapX = headingBox.x + headingBox.width - 6;
    const tapY = headingBox.y + headingBox.height / 2;
    const deadSpace = tapX - (glyphBox.x + glyphBox.width);
    expect(
      deadSpace,
      "the probe must land beyond the drawn identity — otherwise it is not testing the dead space",
    ).toBeGreaterThan(8);

    await page.touchscreen.tap(tapX, tapY);

    await expect(
      panel,
      "tapping the card heading beside the nick must open the row's detail",
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

test("#1223 @webkit on a phone a detail fact gives its value the panel's full width", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`facts1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).tap();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const facts = panel.locator(".adm-facts");
    const factsBox = await boxOf(facts, "the facts list");
    const dtBox = await boxOf(facts.locator("dt").first(), "the first fact's label");
    const ddBox = await boxOf(facts.locator("dd").first(), "the first fact's value");

    // The label is a caption ABOVE its value, not a track beside it.
    expect(
      ddBox.y,
      `the value must sit under its label on a narrow panel (facts list ${Math.round(factsBox.width)}px wide)`,
    ).toBeGreaterThanOrEqual(dtBox.y + dtBox.height - 0.5);

    // And the point of moving it: the value gets the width the label track
    // and its gap were taking. Separate from the assertion above because a
    // collapse that left a fixed label column would satisfy that one.
    expect(
      ddBox.width,
      "the value track must take essentially the whole panel width",
    ).toBeGreaterThanOrEqual(factsBox.width * 0.9);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

test("#1223 on a wide panel the facts stay two columns", async ({ page }) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`wide1223-${Date.now()}`);

  try {
    await adminLogin(page);
    await openSessionsTab(page);

    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    await page.getByTestId(`admin-session-details-${key}`).click();
    const panel = page.getByTestId(`admin-session-detail-${key}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const facts = panel.locator(".adm-facts");
    const dtBox = await boxOf(facts.locator("dt").first(), "the first fact's label");
    const ddBox = await boxOf(facts.locator("dd").first(), "the first fact's value");

    // Beside, not under: the phone fix is a container query, so a panel with
    // room keeps the label column that makes a list of facts scannable.
    expect(
      ddBox.x,
      "with room for two columns the value must sit beside its label",
    ).toBeGreaterThanOrEqual(dtBox.x + dtBox.width);
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});

// Item 1, the half only a browser can see. The panel's subtitle promises
// "the columns the table drops on a phone", and until #1223 it was the one
// thing on screen that was false: `.adm-col-detail { display: none }` is
// (0,1,0) and lost to the `.adm-table td` stacking rule (0,1,1), so every
// dropped column came back as a labelled line of the card and the panel
// underneath said it a second time.
//
// The oracle is the report itself — no value may be on the card AND in the
// panel — rather than a check that a particular selector is hidden: that is
// the property vjt read off the screen, and it survives the next tab growing
// a column.
test("#1223 @webkit on a phone no field is on the card and in the panel at once", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const adminId = (JSON.parse(admin.subjectJson) as { id: string }).id;

  await adminLogin(page);
  await openUsersTab(page);

  const row = page.getByTestId(`admin-user-row-${adminId}`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  const panel = page.getByTestId(`admin-user-detail-${adminId}`);
  await expect(panel).toHaveCount(0);
  await page.getByTestId(`admin-user-details-${adminId}`).tap();
  await expect(panel).toBeVisible({ timeout: 5_000 });

  const cardValues = await paintedCellTexts(row);
  const factValues = (await panel.locator("dd").allTextContents())
    .map((t) => t.trim())
    .filter((t) => t !== "");

  // Non-vacuity, both sides: an empty card or an empty panel would make the
  // intersection trivially empty and the test a mirror.
  expect(cardValues.length, "the row card must still show something").toBeGreaterThan(0);
  expect(factValues.length, "the panel must carry the dropped columns").toBeGreaterThan(0);

  expect(
    factValues.filter((value) => cardValues.includes(value)),
    `values printed twice — card ${JSON.stringify(cardValues)}, panel ${JSON.stringify(factValues)}`,
  ).toEqual([]);
});

// The band the console's two breakpoints leave between them. 820px is a
// portrait iPad: the CSS has already turned the table into cards and taken
// the secondary columns away, and `isMobile()` — 768px — says desktop.
test.describe("#1223 the 769-899 band", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("#1223 the columns leave and the door to their panel is there", async ({ page }) => {
    const admin = getSeededAdmin();
    const adminId = (JSON.parse(admin.subjectJson) as { id: string }).id;

    await adminLogin(page);
    await openUsersTab(page);

    const row = page.getByTestId(`admin-user-row-${adminId}`);
    await expect(row).toBeVisible();

    // Gone from the card: this is the width at which the drop applies.
    const dropped = row.locator("td.adm-col-detail");
    expect(await dropped.count(), "the secondary cells must still be in the DOM").toBeGreaterThan(
      0,
    );
    for (let i = 0; i < (await dropped.count()); i++) {
      await expect(dropped.nth(i)).toBeHidden();
    }

    // And reachable: the disclosure has to exist wherever the columns leave,
    // or this band is where the record becomes unreadable.
    await page.getByTestId(`admin-user-details-${adminId}`).click();
    const panel = page.getByTestId(`admin-user-detail-${adminId}`);
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel).toContainText("live sessions");
    await expect(panel).toContainText("inserted");
  });
});
