import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHORT_HASH_LEN } from "../lib/bundleHash";
import { PULL_COMMIT_PX } from "../lib/pullGesture";
import { PUSH_OPTIN_DECLINED_KEY } from "../lib/pushOptin";
import { REPLY_QUOTE_BODY_LIMIT, REPLY_QUOTE_TAIL } from "../lib/replyQuote";
import { UNREAD_RETENTION_CAP } from "../lib/scrollback";
import { LOAD_MORE_THRESHOLD_PX, SCROLL_BOTTOM_THRESHOLD_PX } from "../lib/scrollThresholds";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #1646 — the e2e tree hand-copies production constants, and until this file
// nothing compared a copy with its original.
//
// The copies are deliberate: `e2e/` is its own package (`e2e/package.json`,
// playwright-only) and `fixtures/grappaApi.ts` spells out why the ONE import it
// allows itself is type-only — a value import would reach the solid-js
// dependency graph that keeps the runner image a pure REST/IRC client. The
// mirroring is not the defect. The defect is that "kept in lockstep by hand"
// had no witness: every one of the declarations below could be edited, or its
// original could move, and every gate in the repo stayed green.
//
// So the pin reads the e2e declaration as TEXT and compares it with the
// production constant IMPORTED here. The two sides come from genuinely
// different places — a module import and a file the test never imports — which
// is what makes the comparison able to fail. It fails in both directions:
// change production and the import moves while the text does not; change the
// copy and the text moves while the import does not.
//
// This lives in `src/__tests__/` rather than in `e2e/fixtures/` (which the
// vitest lane also collects) precisely BECAUSE of the rule it is guarding: a
// pin in `e2e/` would have to import src values, which is the edge the e2e
// package refuses. Reading the spec files as text creates no import edge at
// all. Sibling of `biomePin.test.ts` / `moduleRootGuard.test.ts` /
// `versionSource.test.ts` — vitest runs from the cicchetto dir, so both `src`
// and `e2e` are at cwd.
//
// ⚠️ SCOPE. #1646 measured 13 production constants copied into 53 e2e
// declarations. Slice 1 pinned the 6 whose production side was TypeScript and
// ALREADY exported — 11 declarations — and left the other 7 to a product call.
// Slice 2 took that call (vjt, 2026-08-21) and closed all of them:
//   - `SCROLL_BOTTOM_THRESHOLD_PX` + `LOAD_MORE_THRESHOLD_PX` (22 declarations)
//     MOVED out of `ScrollbackPane.tsx` into `src/lib/scrollThresholds.ts`,
//     which argues its own case. They are `MIRRORS` rows like any other now.
//   - `PUSH_OPTIN_DECLINED_KEY` + `SHORT_HASH_LEN` (1 each) were already under
//     `lib/` and only lacked `export`; each declaration says why exporting it
//     gives away nothing it had.
//   - `AWAY_SET_NOTICE` (1) stays private, and is pinned by `TEXT_MIRRORS` —
//     the weaker text-vs-text oracle. See that table for the refusal.
//   - the 2 Elixir module attributes (17 declarations) are pinned SERVER-SIDE,
//     in `test/grappa_web/controllers/messages_limit_mirror_test.exs`. They
//     cannot be pinned from here: `scripts/bun.sh` bind-mounts ONLY
//     `cicchetto/` at `/app`, so no path from this file reaches `lib/*.ex`.
//     Do not try — `../lib` RESOLVES inside that container, to the Debian
//     image's own `/lib`, and only the read fails.
// `mix grappa.gen_wire_types` was considered for the Elixir pair and declined:
// it ships wire TYPES, and teaching it to carry arbitrary constants inflates it
// for two numbers a text read already covers.
//
// ⚠️ What this CANNOT do: it cannot find a mirror that has ALREADY drifted.
// Every declaration below was found because the two sides carry the same
// literal today. A copy that already disagrees with production is invisible to
// the census that produced this table, and adding it here is the only way it
// enters. `KNOWN_UNPINNED` names the one set where that question is open.

/** A hand-copied e2e declaration and the production constant it mirrors. */
type Mirror = {
  /** e2e file, relative to the cicchetto dir. */
  readonly file: string;
  /** The name the e2e side gives it — often NOT the production spelling. */
  readonly name: string;
  /** The production value, imported. Derived values arrive already computed. */
  readonly production: string | number;
  /** Where production defines it, for the failure message. */
  readonly origin: string;
};

const MIRRORS: readonly Mirror[] = [
  // `$list` — the channel-directory pseudo-window (#84).
  ...[
    "e2e/tests/channel-directory.spec.ts",
    "e2e/tests/issue1445-directory-pull-refresh.spec.ts",
    "e2e/tests/issue220-link-double-fire.spec.ts",
    "e2e/tests/issue244-directory-tap-foreground.spec.ts",
    "e2e/tests/issue2505-sidebar-row-glyph-alignment.spec.ts",
    "e2e/tests/issue677-directory-pagination.spec.ts",
  ].map(
    (file): Mirror => ({
      file,
      name: "LIST_WINDOW_NAME",
      production: LIST_WINDOW_NAME,
      origin: "LIST_WINDOW_NAME (src/lib/windowKinds.ts)",
    }),
  ),

  // `$server` — the synthetic per-network server window. Two spellings on the
  // e2e side for one production constant, which is itself part of why the
  // lockstep needs a machine: a grep for the production NAME finds neither.
  {
    file: "e2e/tests/issue276-away-emoji-badge.spec.ts",
    name: "SERVER_WINDOW",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },
  // issue 2024 — the CTCP-query spec asserts the visibility row lands in the
  // network window, so `$server` IS the fact under test and copying it is not
  // an option to be talked out of: the e2e runner mounts `cicchetto/e2e` alone
  // at `/work` (`compose.yaml`, `- .:/work`), so `../../src/lib/windowKinds`
  // does not exist at runtime and an import of the VALUE cannot resolve. A
  // pinned copy is the mechanism; KNOWN_UNPINNED would be a lie, because this
  // value is not a question.
  {
    file: "e2e/tests/issue2024-ctcp-query-no-minted-tab.spec.ts",
    name: "SERVER_WINDOW",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },
  {
    file: "e2e/tests/m12-motd-server-window-routes-notice.spec.ts",
    name: "SERVER_CHANNEL",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },
  // issue 1365 — this one arrived as a SEVENTH `"Server"`, and the census
  // caught it exactly as the KNOWN_UNPINNED note below says it would. It is
  // pinned rather than listed there because measuring it answered the question
  // instead of inheriting it: `sidebarWindow` resolves the legacy `"Server"`
  // alias and the production `"$server"` to the same
  // `[data-window-name="$server"]` locator, so spelling it the production way
  // costs nothing at runtime and makes the declaration a copy with an original.
  // The six below stay open because THEIR question is whether `"Server"` itself
  // mirrors something live; this spec simply wants the server window.
  {
    file: "e2e/tests/issue1365-dm-bucket-after-own-nick-steal.spec.ts",
    name: "SERVER_WINDOW",
    production: SERVER_WINDOW_NAME,
    origin: "SERVER_WINDOW_NAME (src/lib/windowKinds.ts)",
  },

  {
    file: "e2e/tests/issue1105-reply-quote-caret-visible.spec.ts",
    name: "REPLY_QUOTE_TAIL",
    production: REPLY_QUOTE_TAIL,
    origin: "REPLY_QUOTE_TAIL (src/lib/replyQuote.ts)",
  },
  {
    file: "e2e/tests/issue1105-reply-quote-caret-visible.spec.ts",
    name: "QUOTED_BODY_LIMIT",
    production: REPLY_QUOTE_BODY_LIMIT,
    origin: "REPLY_QUOTE_BODY_LIMIT (src/lib/replyQuote.ts)",
  },

  // The DERIVED one, and the reason a value pin beats a name pin. Its
  // production side is not a literal — `UNREAD_RETENTION_CAP = PAGE_LIMIT` — so
  // the number the e2e copy froze can be moved from a module the copy does not
  // even name. Importing the constant pins the computed value, which is the one
  // the product uses.
  {
    file: "e2e/tests/issue1229-unread-retention-bound.spec.ts",
    name: "UNREAD_BOUND",
    production: UNREAD_RETENTION_CAP,
    origin: "UNREAD_RETENTION_CAP = PAGE_LIMIT (src/lib/scrollback.ts)",
  },

  // Was the SECOND derived one until #1671: `PULL_COMMIT_PX = SWIPE_MIN_PX * 2`
  // became a plain 160 when vjt measured the distance on a phone, because a
  // measurement is not a multiple of the swipe floor. The pin is unchanged and
  // it is the reason that landed cleanly — it went red on this very row,
  // naming the e2e line still holding 80. What it stopped covering went with
  // the derivation and not with the pin: there is no third module left whose
  // edit could move this value.
  {
    file: "e2e/tests/issue1445-directory-pull-refresh.spec.ts",
    name: "PULL_COMMIT_PX",
    production: PULL_COMMIT_PX,
    origin: "PULL_COMMIT_PX (src/lib/pullGesture.ts)",
  },

  // The scroll-edge pair (#1646 slice 2). `SCROLL_BOTTOM_THRESHOLD_PX` is the
  // most-copied constant in the tree by a wide margin — one declaration per
  // spec that has to decide "is this pane at its tail". The count is the list
  // below and is deliberately not restated in prose: it grows with every such
  // spec, and a number here would be wrong by the next one.
  ...[
    "e2e/fixtures/scrollGesture.test.ts",
    "e2e/tests/bug7-ios-own-msg-visible.spec.ts",
    "e2e/tests/bug7-m6-ios-dm-own-msg-visible.spec.ts",
    "e2e/tests/cp14-b1-scroll-marker-vs-bottom.spec.ts",
    "e2e/tests/issue1089-switch-into-unread-flicker.spec.ts",
    "e2e/tests/issue1121-overlay-close-tail-reader.spec.ts",
    "e2e/tests/issue168-scroll-authority.spec.ts",
    "e2e/tests/issue196-preview-scroll-live-arrival.spec.ts",
    "e2e/tests/issue2031-send-with-marker-row-clipped.spec.ts",
    "e2e/tests/issue243-tap-active-scroll-bottom.spec.ts",
    "e2e/tests/issue253-kbd-resize-scroll-preserve.spec.ts",
    "e2e/tests/issue280-button-coexist.spec.ts",
    "e2e/tests/issue289-float-btn-opacity.spec.ts",
    "e2e/tests/issue310-scroll-to-bottom-btn-cursor.spec.ts",
    "e2e/tests/issue360-scroll-to-bottom-mention-badge.spec.ts",
    "e2e/tests/issue535-visibility-return-preserve-scroll.spec.ts",
    "e2e/tests/issue580-send-snap-independent-of-post.spec.ts",
    "e2e/tests/issue625-single-send-scroll-jump.spec.ts",
    "e2e/tests/scroll-multi-roundtrip-contamination.spec.ts",
    "e2e/tests/scroll-on-window-switch.spec.ts",
    "e2e/tests/scroll-to-bottom-button-contamination.spec.ts",
  ].map(
    (file): Mirror => ({
      file,
      name: "SCROLL_BOTTOM_THRESHOLD_PX",
      production: SCROLL_BOTTOM_THRESHOLD_PX,
      origin: "SCROLL_BOTTOM_THRESHOLD_PX (src/lib/scrollThresholds.ts)",
    }),
  ),
  ...[
    "e2e/tests/cp14-b2-scroll-up-loadmore.spec.ts",
    "e2e/tests/issue1094-prepend-preserve-commit.spec.ts",
    "e2e/tests/issue253-kbd-resize-scroll-preserve.spec.ts",
  ].map(
    (file): Mirror => ({
      file,
      name: "LOAD_MORE_THRESHOLD_PX",
      production: LOAD_MORE_THRESHOLD_PX,
      origin: "LOAD_MORE_THRESHOLD_PX (src/lib/scrollThresholds.ts)",
    }),
  ),

  {
    file: "e2e/tests/push-459-optin-banner.spec.ts",
    name: "PUSH_OPTIN_DECLINED_KEY",
    production: PUSH_OPTIN_DECLINED_KEY,
    origin: "PUSH_OPTIN_DECLINED_KEY (src/lib/pushOptin.ts)",
  },
  {
    file: "e2e/tests/issue1063-refresh-visible-feedback.spec.ts",
    name: "SHORT_HASH_LEN",
    production: SHORT_HASH_LEN,
    origin: "SHORT_HASH_LEN (src/lib/bundleHash.ts)",
  },
];

/**
 * A mirror whose production side is read as TEXT rather than imported.
 *
 * A WEAKER oracle than `Mirror`, and used only where importing the original
 * would mean changing production to suit a test. Both sides are read off disk,
 * so this catches the two copies drifting apart — the defect #1646 names — but
 * unlike `Mirror` it never observes the value the product actually computes.
 * Prefer `Mirror`; reach for this when the alternative is moving or exporting a
 * constant that has no business being moved or exported.
 */
type TextMirror = {
  /** e2e file, relative to the cicchetto dir. */
  readonly file: string;
  /** The name the e2e side gives it. */
  readonly name: string;
  /** The production file, relative to the cicchetto dir. */
  readonly originFile: string;
  /** The production spelling — regularly NOT the e2e spelling. */
  readonly originName: string;
};

// `AWAY_SET_NOTICE` stays private in `ComposeBox.tsx` (#1646 slice 2), and this
// is the pin that costs production nothing to get.
//
// It is one half of a PAIR — `AWAY_UNSET_NOTICE` is its twin and has no e2e
// mirror at all — and its own comment places it in a family kept beside the
// component that renders it ("Same lowercase-topic register as the other
// notices"). Moving it to `lib/` would split the pair and make it the only
// centralised notice string in the tree, to buy a pin on ONE declaration; the
// scroll-edge pair moved because the concept was already shared, and this one
// is not. Exporting it in place would be the same trade with a smaller radius.
// So both sides are read as text instead.
const TEXT_MIRRORS: readonly TextMirror[] = [
  {
    file: "e2e/tests/issue1226-away-seam-feedback.spec.ts",
    name: "AWAY_SET_LINE",
    originFile: "src/ComposeBox.tsx",
    originName: "AWAY_SET_NOTICE",
  },
];

// Declarations that carry a PINNED NAME but no pin, each with the reason.
//
// `SERVER_WINDOW = "Server"` — six specs use the literal `"Server"` as a
// window/channel name under the same identifier two specs give `"$server"`.
// #1646 could not establish whether those six mirror a live production string,
// a retired one, or nothing at all: the src side records the `"Server"` LABEL
// as gone (`BottomBar.tsx`, `__tests__/Sidebar.test.tsx`) while
// `__tests__/subscribe.test.ts` still passes it as a `channelName`. Pinning
// them to `SERVER_WINDOW_NAME` would assert a fact nobody has measured, and
// deleting them from the sweep silently would hide the question. They are
// listed, so a SEVENTH one cannot appear without someone reading this.
//
// One did, and the mechanism worked: issue 1365's e2e landed a seventh
// `SERVER_WINDOW = "Server"` and this sweep reddened on it. It is NOT in the
// list below — it was respelled `"$server"` and pinned in `MIRRORS`, because
// measuring `sidebarWindow` showed both spellings resolve to the same locator,
// so that spec's value is a copy with an original rather than the open
// question these six carry. The count below stays SIX, and an EIGHTH still
// cannot appear unread.
const KNOWN_UNPINNED: readonly { readonly file: string; readonly name: string }[] = [
  { file: "e2e/tests/issue239-hidden-msg-unread.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue267-mention-server-authoritative.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue498-badge-follows-live-nick.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue973-query-unread-badge-clears.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/issue981-no-badge-at-tail.spec.ts", name: "SERVER_WINDOW" },
  { file: "e2e/tests/m2-irssi-to-chan-defocused.spec.ts", name: "SERVER_WINDOW" },
];

/** A single-line `const`/`let NAME = <literal>` declaration, as written. */
type Declaration = { readonly line: number; readonly literal: string };

// Prose carries the history, and several comments quote the very declarations
// this file reads. Same guard as `moduleRootGuard.test.ts`.
const isProse = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

/**
 * Every single-line declaration of `name` in `src`, literal text unparsed.
 *
 * @spec declarationsOf(string, string) :: Declaration[] — empty when absent,
 * which every caller treats as a failure rather than a pass.
 */
function declarationsOf(src: string, name: string): Declaration[] {
  const pattern = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*(.+?);?\\s*$`);
  const found: Declaration[] = [];
  src.split("\n").forEach((line, i) => {
    if (isProse(line)) return;
    const m = pattern.exec(line);
    if (m?.[1] !== undefined) found.push({ line: i + 1, literal: m[1] });
  });
  return found;
}

/**
 * The value of a mirror's literal.
 *
 * @spec parseLiteral(string) :: string | number | null — null for anything
 * that is not a plain double-quoted string or a plain number. A mirror written
 * as a template literal, an expression or a concatenation is NOT silently
 * accepted: the caller fails and names the line, because a pin that shrugs at
 * a shape it cannot read is a pin that stops covering a declaration the day
 * someone reformats it.
 */
function parseLiteral(literal: string): string | number | null {
  if (/^"(?:[^"\\]|\\.)*"$/.test(literal)) return JSON.parse(literal) as string;
  if (/^-?\d+(?:\.\d+)?$/.test(literal)) return Number(literal);
  return null;
}

function e2eSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `e2e/node_modules` is the runner's own install; `test-results` and
    // `playwright-report` are run output. None of them is a hand-written
    // mirror, and walking them costs seconds.
    if (entry === "node_modules" || entry === "test-results" || entry === "playwright-report") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...e2eSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the extractor (#1646 — the predicate)", () => {
  // A guard that only ever runs over a tree it already agrees with proves
  // nothing about what it would catch, so the predicate is pinned on its own.
  it("reads a plain declaration", () => {
    expect(declarationsOf(`const FOO = "$list";`, "FOO")).toEqual([
      { line: 1, literal: `"$list"` },
    ]);
  });

  it("reads a typed declaration and a `let`", () => {
    expect(declarationsOf(`const FOO: string = "x";`, "FOO")).toEqual([
      { line: 1, literal: `"x"` },
    ]);
    expect(declarationsOf(`let FOO = 50;`, "FOO")).toEqual([{ line: 1, literal: "50" }]);
  });

  it("does not read a comment that quotes the declaration", () => {
    expect(declarationsOf(`// const FOO = "$list";`, "FOO")).toEqual([]);
  });

  it("does not read a DIFFERENT name that ends with the one asked for", () => {
    expect(declarationsOf(`const NOT_FOO = 1;`, "FOO")).toEqual([]);
  });

  it("finds every occurrence, with its line", () => {
    expect(declarationsOf(`const FOO = 1;\nconst BAR = 2;\nconst FOO = 3;`, "FOO")).toEqual([
      { line: 1, literal: "1" },
      { line: 3, literal: "3" },
    ]);
  });

  it("parses the two shapes a mirror may take, and refuses the rest", () => {
    expect(parseLiteral(`" << "`)).toBe(" << ");
    expect(parseLiteral("200")).toBe(200);
    expect(parseLiteral("-1")).toBe(-1);
    expect(parseLiteral("`$list`")).toBeNull();
    expect(parseLiteral(`"$" + "list"`)).toBeNull();
    expect(parseLiteral("SWIPE_MIN_PX * 2")).toBeNull();
  });
});

describe("e2e mirrors of production constants (#1646)", () => {
  for (const mirror of MIRRORS) {
    it(`${mirror.file} — ${mirror.name} still equals ${mirror.origin}`, () => {
      const declarations = declarationsOf(readFileSync(mirror.file, "utf8"), mirror.name);

      // Zero is the failure this assertion exists for as much as a wrong value
      // is: a renamed or deleted mirror must not make the pin pass by having
      // nothing left to compare. More than one means the table stopped
      // describing the file.
      expect(declarations, `no \`${mirror.name}\` declaration in ${mirror.file}`).toHaveLength(1);

      const declaration = declarations[0] as Declaration;
      const value = parseLiteral(declaration.literal);
      expect(
        value,
        `${mirror.file}:${declaration.line} — \`${declaration.literal}\` is not a plain literal, so this pin no longer reads it`,
      ).not.toBeNull();
      expect(
        value,
        `${mirror.file}:${declaration.line} — the copy of ${mirror.origin} has drifted`,
      ).toBe(mirror.production);
    });
  }

  for (const mirror of TEXT_MIRRORS) {
    it(`${mirror.file} — ${mirror.name} still equals ${mirror.originName} (${mirror.originFile}, read as text)`, () => {
      // Deliberately the SAME extractor on both sides. The production file is a
      // `.tsx` component this test must not import — that is the whole reason
      // the pin is here — so "read the declaration as text" is applied twice
      // rather than once, and each side must yield exactly one plain literal.
      const sides = [
        { label: mirror.originFile, name: mirror.originName },
        { label: mirror.file, name: mirror.name },
      ].map((side) => {
        const declarations = declarationsOf(readFileSync(side.label, "utf8"), side.name);
        expect(declarations, `no \`${side.name}\` declaration in ${side.label}`).toHaveLength(1);

        const declaration = declarations[0] as Declaration;
        const value = parseLiteral(declaration.literal);
        expect(
          value,
          `${side.label}:${declaration.line} — \`${declaration.literal}\` is not a plain literal, so this pin no longer reads it`,
        ).not.toBeNull();
        return value;
      });

      expect(
        sides[1],
        `${mirror.file} — the copy of ${mirror.originName} (${mirror.originFile}) has drifted`,
      ).toBe(sides[0]);
    });
  }

  it("has no mirror outside the table", () => {
    const pinned = new Set(MIRRORS.map((m) => `${m.file}\0${m.name}`));
    for (const text of TEXT_MIRRORS) pinned.add(`${text.file}\0${text.name}`);
    for (const known of KNOWN_UNPINNED) pinned.add(`${known.file}\0${known.name}`);
    const names = [...new Set([...MIRRORS, ...TEXT_MIRRORS].map((m) => m.name))];

    const unlisted: string[] = [];
    for (const file of e2eSourceFiles("e2e")) {
      const src = readFileSync(file, "utf8");
      for (const name of names) {
        if (declarationsOf(src, name).length === 0) continue;
        if (!pinned.has(`${file}\0${name}`)) unlisted.push(`${file} — ${name}`);
      }
    }

    // A new copy of an already-copied constant is the cheapest way back to the
    // state #1646 measured, and it is the one case a table-driven pin can see
    // coming. Landing one means adding it to MIRRORS (or, if its value is a
    // question rather than a copy, to KNOWN_UNPINNED with the reason).
    expect(unlisted).toEqual([]);
  });
});
