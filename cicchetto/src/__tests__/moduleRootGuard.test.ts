import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #717 — a module-lifetime reactive computation must not run without an error
// context.
//
// The first cut of #717 gave the error context to `identityScopedStore` alone
// and left every other module root bare. `activeWindows.ts` — a module-level
// memo reading `channelsBySlug()` and `networks()`, subscribed before the first
// render — then went on swallowing the `listNetworks`/`listChannels` failures
// exactly as before: it runs EARLIER in the Updates queue than the store's own
// memo, throws with no error context, and `runUpdates` discards the queued
// render effects before the store's handler is ever reached. The splash froze
// through the gap between the two patterns.
//
// CLAUDE.md: "Half-migrated creates two patterns — Claude copies whichever is
// closer." So the migration is total and this test is what keeps it total. A
// new root goes through `moduleRoot`; nothing else may own one.
//
// Sibling of biomePin.test.ts / versionSource.test.ts — vitest runs from the
// cicchetto dir, so `src` is at cwd.

// The two factories are the door itself: `moduleRoot` opens the root, and
// `identityScopedStore` opens one with the reset wiring deliberately OUTSIDE
// the error context (see its header — a swallowed reset is #281's bug).
const FACTORIES = ["src/lib/moduleRoot.ts", "src/lib/identityScopedStore.ts"];

// Test files are out of scope. The reason is the ERROR CONTEXT, not the shape:
// a test module's root dies with the worker, and a throw inside one surfaces as
// a failing test — the runner IS the context this guard exists to supply. (The
// shape argument this comment used to make — "every one of them takes the
// `dispose` callback" — is not true: `home.test.ts`, `railWhois.test.ts`,
// `whoisCard.test.ts` and `subscribe.test.ts` each open one that does not.
// Those roots leak within their worker; that is a test-hygiene matter, not a
// #717 one, and it is not what this guard is for.)
const isTestFile = (rel: string): boolean =>
  rel.includes("__tests__") || /\.test\.tsx?$/.test(rel) || rel === "src/setupTests.ts";

// Matches a call, not the word: comments and prose about `createRoot` are fine
// and there are several that explain the history.
const ROOT_CALL = /\bcreateRoot\s*\(/;

// A root whose callback BINDS the dispose argument is scoped — the author holds
// the handle and the root ends. A root that ignores it is module-LIFETIME: never
// disposed, so a throw inside it has nowhere to go. That, not the spelling, is
// what the door exists for. Covers `d => …`, `(dispose) => …` and the `async`
// forms; anything else is treated as owning, which is the safe default.
const DISPOSING_ROOT = /\bcreateRoot\s*\(\s*(?:async\s+)?(?:\(\s*[A-Za-z_$]|[A-Za-z_$][\w$]*\s*=>)/;

// The reactive primitives whose throw aborts the update cycle. `createSignal`
// is absent on purpose: a signal is a value cell, it runs no user code and
// cannot throw into `runUpdates`.
const COMPUTATION = /\bcreate(?:Effect|Memo|Resource|Computed|RenderEffect)\s*\(/;

// Module scope, detected as "starts at column 0". biome owns the formatting, so
// anything nested is indented — a heuristic, but a pinned one, and the failure
// direction is a false POSITIVE the author fixes by moving the call into the
// root where it already belonged.
const isModuleScope = (line: string): boolean => !/^\s/.test(line);

// A root opened on the same line owns what follows it there:
// `moduleRoot(() => createSignal(0))` is one line and correctly scoped.
const OPENS_ROOT = /\b(?:moduleRoot|createRoot)\s*\(/;

// Prose lines carry the migration's history; several of them quote the very
// calls this guard forbids.
const isProse = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

type Offence = { line: number; rule: "owning-root" | "unowned-computation" };

/**
 * Classify one module's source. Pure over text so the fixtures below can pin
 * the predicate itself — a guard that only ever runs over a clean tree proves
 * nothing about what it would catch.
 *
 * Two rules, one invariant ("every module-lifetime computation has an error
 * context"): a root that never disposes must come from `moduleRoot`, and a
 * computation at module scope must be inside a root at all. #779.1 — the
 * second rule is the one the original spelling-based guard could not express,
 * and a module-scope `createMemo` with `Owner === null` reproduces the #717
 * freeze exactly.
 */
function offences(src: string): Offence[] {
  const found: Offence[] = [];
  src.split("\n").forEach((line, i) => {
    if (isProse(line)) return;
    if (ROOT_CALL.test(line) && !DISPOSING_ROOT.test(line)) {
      found.push({ line: i + 1, rule: "owning-root" });
      return;
    }
    if (COMPUTATION.test(line) && isModuleScope(line) && !OPENS_ROOT.test(line)) {
      found.push({ line: i + 1, rule: "unowned-computation" });
    }
  });
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("module roots (#717 — the predicate)", () => {
  it("flags a root that ignores its dispose argument — that root is forever", () => {
    expect(offences("const exports_ = createRoot(() => {")).toEqual([
      { line: 1, rule: "owning-root" },
    ]);
  });

  it("allows a root that BINDS dispose — scoped ownership is what createRoot is for", () => {
    // #779.3 — a detached/portal render is normal Solid and correct in
    // production code. Without this arm the next author needing one is pushed
    // into `moduleRoot` (wrong: it never disposes, so they leak a root) or
    // into an exclusion list, which CLAUDE.md forbids.
    expect(offences("  const dispose = createRoot((dispose) => render(el));")).toEqual([]);
    expect(offences("  createRoot(async (d) => {")).toEqual([]);
    expect(offences("  createRoot((d) => {")).toEqual([]);
  });

  it("flags a module-scope computation with no root at all", () => {
    // #779.1 — THE evasion the spelling-based guard cannot see. A module-scope
    // `createEffect`/`createMemo`/`createResource` outside any root has
    // `Owner === null`, so `handleError` finds no handler and rethrows out of
    // `runUpdates`: the identical cycle abort, the identical frozen last frame,
    // the identical #717 signature. Solid only emits a dev-mode console.warn.
    expect(offences("export const live = createMemo(() => channels().length);")).toEqual([
      { line: 1, rule: "unowned-computation" },
    ]);
    expect(offences("createEffect(() => syncBadge(count()));")).toEqual([
      { line: 1, rule: "unowned-computation" },
    ]);
  });

  it("allows a computation nested inside something — only module scope is unowned", () => {
    expect(offences("  const live = createMemo(() => channels().length);")).toEqual([]);
    expect(offences("const [c, setC] = moduleRoot(() => createSignal(0));")).toEqual([]);
    // A one-line root: the computation is lexically inside its callback.
    expect(offences("const live = moduleRoot(() => createMemo(() => 1));")).toEqual([]);
  });

  it("ignores prose — the migration left explanatory comments quoting both calls", () => {
    expect(offences("//   const exports_ = createRoot(() => {")).toEqual([]);
    expect(offences(" * compiles for `createResource(user, …)`")).toEqual([]);
  });
});

describe("module roots (#717 — one door, and it stays one)", () => {
  it("has no owning root and no unowned computation outside the root factories", () => {
    const root = resolve(process.cwd(), "src");
    const found: string[] = [];

    for (const file of sourceFiles(root)) {
      const rel = relative(process.cwd(), file);
      if (FACTORIES.includes(rel) || isTestFile(rel)) continue;
      for (const o of offences(readFileSync(file, "utf8"))) {
        found.push(`${rel}:${o.line} (${o.rule})`);
      }
    }

    expect(
      found,
      `use moduleRoot() so the root gets an error context (#717):\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("still guards something — the factories themselves open an owning root", () => {
    // Without this, deleting both factories (or renaming the call) would leave
    // the test above vacuously green. #779.2 — it runs through `offences`, so a
    // factory reduced to PROSE about `createRoot` no longer satisfies it: the
    // literal `//   const exports_ = createRoot(() => {` in
    // identityScopedStore's pattern-history comment used to.
    const called = FACTORIES.filter(
      (f) => offences(readFileSync(resolve(process.cwd(), f), "utf8")).length > 0,
    );
    expect(called).toEqual(FACTORIES);
  });
});
