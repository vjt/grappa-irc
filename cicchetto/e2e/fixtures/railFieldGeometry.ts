// #857 — the rail's definition-list cards must STACK: every `<dt>` and every
// `<dd>` on its own row at the full card width. Two of the client's four
// `<dl>`s mount in the rail (`RailContext` renders `ServerInfoCard` on a
// server window and `WhoisCard` on a query), and both shipped as
// `grid-template-columns: max-content 1fr`. In a full-width centre pane that
// is right; inside the #605-capped `fit-content(14rem)` rail the label track
// eats most of the card and `word-break: break-word` then chops each value a
// few characters at a time.
//
// The oracle has to be a real engine: the defect and the fix are rendered
// geometry, and jsdom has no layout. Hence one shared helper rather than a
// copy per spec — the rule is one rule.
//
// MEASURED, not assumed (#858 diagnosis, chromium, rail dl width 156px):
// counting a `Range`'s client rects over the whole `<dd>` OVERCOUNTS lines.
// For a `<dd>` holding `<span class="whois-card-channel">#bofh</span>`
// (`display: inline-block`) the range yields TWO rects of identical width —
// `t=329.72 h=16.66 w=35.69` (the inline-block's border box, height = the
// 1.4 line-height) and `t=330.72 h=14.00 w=35.69` (the text inside it, height
// = the font box). Same content, counted twice, one pixel of half-leading
// apart. So line boxes are counted over TEXT NODES only: a text node that
// wraps still yields one rect per line (measured: `172.24.Azzurra-580278E6`
// at t=91.72 and t=108.38), while an element box contributes none.

import { expect, type Locator } from "@playwright/test";

/** Roughly "one short word per line" — vjt's acceptance floor for #857. */
const MIN_CHARS_PER_LINE = 8;

type FieldRow = { tag: string; label: string; len: number; width: number; lines: number };
type FieldGeometry = { dlWidth: number; rows: FieldRow[] };

const measureFields = (card: Locator, dlSelector: string): Promise<FieldGeometry> =>
  card.evaluate((el, sel) => {
    const dl = el.querySelector(sel);
    if (dl === null) throw new Error(`card has no ${sel}`);
    const rows: FieldRow[] = [];
    let label = "";
    for (const kid of Array.from(dl.children)) {
      const text = kid.textContent ?? "";
      if (kid.tagName === "DT") label = text;
      const tops = new Set<number>();
      const walker = document.createTreeWalker(kid, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 && rect.height === 0) continue;
          tops.add(Math.round(rect.top));
        }
      }
      rows.push({
        tag: kid.tagName,
        label,
        len: text.length,
        width: kid.getBoundingClientRect().width,
        lines: Math.max(tops.size, 1),
      });
    }
    return { dlWidth: dl.getBoundingClientRect().width, rows };
  }, dlSelector) as Promise<FieldGeometry>;

/**
 * Assert a rail-mounted `<dl>` is stacked: no two-column content anywhere in
 * it. Every `<dt>` and `<dd>` spans the whole card (a label track leaves them
 * a fraction — that IS the bug) and no value wraps below one short word per
 * line.
 */
export const expectRailFieldsStacked = async (card: Locator, dlSelector: string) => {
  const fields = await measureFields(card, dlSelector);
  expect(fields.rows.length, `${dlSelector} rendered no rows to measure`).toBeGreaterThan(1);
  for (const row of fields.rows) {
    expect(
      row.width,
      `rail ${row.tag} "${row.label}" is ${row.width}px of the card's ${fields.dlWidth}px — still two columns`,
    ).toBeGreaterThanOrEqual(fields.dlWidth - 0.5);
    expect(
      row.lines,
      `rail ${row.tag} "${row.label}" (${row.len} chars) wraps onto ${row.lines} lines`,
    ).toBeLessThanOrEqual(Math.max(1, Math.ceil(row.len / MIN_CHARS_PER_LINE)));
  }
};

/**
 * The complement, and the reason the rail rule is scoped rather than global:
 * where the card HAS the width (the scrollback overlay) the aligned two
 * columns stay. A leaked rail override would give the labels the full width
 * here too.
 */
export const expectFieldsTwoColumn = async (card: Locator, dlSelector: string) => {
  const fields = await measureFields(card, dlSelector);
  const labels = fields.rows.filter((row) => row.tag === "DT");
  expect(labels.length, `${dlSelector} rendered no labels to measure`).toBeGreaterThan(1);
  for (const row of labels) {
    expect(
      row.width,
      `overlay DT "${row.label}" spans the whole card — the rail override leaked`,
    ).toBeLessThan(fields.dlWidth);
  }
};
