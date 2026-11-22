// Issue 2694 — the ratchet on REST bodies read without validation.
//
// `res.json()` is `Promise<any>`. A body read that way and then cast (`as T`),
// or returned straight from a function typed `Promise<T>`, is a type the
// server never promised: rename a field in a view the codegen does not cover
// and cic still compiles green, then reads `undefined`. The cure is
// validating against the generated schema (`narrowRest(S_…)` or a `narrow*`
// helper built on it). Until every read is cured, this gate holds the line:
// the count may only go DOWN, and it goes down by lowering the pin in the same
// commit.
//
// Measured 2026-11-22 on `9d52a9e45`: 63 `(await res.json()) as T` casts
// (`api.ts` 31, `userSettings.ts` 26, `push.ts` 3, `themesApi.ts` 2,
// `serverSettings.ts` 1) — the number the 2026-11-21 architecture review
// counted — PLUS one read the `.json()) as` spelling cannot see:
// `getPasskeyStatus` returns `await res.json()` from a `Promise<PasskeyStatus>`
// function, an `any` turned into a type without the word `as` appearing. So
// the predicate is the WIDE one: every production `.json()` read that is not
// the direct argument of a `narrow*` call.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A `.json()` read that no `narrow*` call validates. */
export type Read = { readonly line: number; readonly spelling: Spelling };

/**
 * How the unvalidated read is written. The gate counts all four alike; the
 * name is there so a red names what it found, and so the controls can prove
 * each spelling is seen.
 */
export type Spelling = "cast" | "cast-next-line" | "bare-cast" | "uncast";

/** The pin: each production file's unvalidated reads. A file absent here is pinned at 0. */
export const PIN: Readonly<Record<string, number>> = {
  "src/lib/api.ts": 32,
  "src/lib/userSettings.ts": 26,
  "src/lib/push.ts": 3,
  "src/lib/themesApi.ts": 2,
  "src/lib/serverSettings.ts": 1,
};

/**
 * Reads that are NOT a REST body, each with its reason. Exact like the pin: a
 * second read in one of these files counts, and an exclusion that no longer
 * matches is itself a failure, so it cannot quietly become room.
 */
export const EXCLUSIONS: Readonly<
  Record<string, { readonly count: number; readonly why: string }>
> = {
  "src/lib/nowPlaying.ts": {
    count: 1,
    why: "a third-party now-playing feed, not grappa's REST; parseNowPlayingFeed validates it",
  },
  "src/service-worker.ts": {
    count: 1,
    why: "a Web Push payload (event.data.json()), read into `unknown` and narrowed by hand",
  },
};

/** Blank out comments, keeping every newline so line numbers survive. */
export function stripComments(source: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// The read is VALIDATED when it is the direct argument of a call whose callee
// starts with `narrow`: `narrowRest(S_X, await res.json())`,
// `narrowThemeResponse(await res.json())`. Measured: every one of the 60
// validated reads on `9d52a9e45` has exactly that shape.
const VALIDATED = /narrow\w*\((?:[^()]*,)?\s*(?:await\s+)?$/;

const CAST = /^\)[ \t]+as\s/;
const CAST_NEXT_LINE = /^\)[ \t]*\n\s*as\s/;
const BARE_CAST = /^\s+as\s/;

/** Every `.json()` read in `source` that no `narrow*` call validates. */
export function unvalidatedReads(source: string): Read[] {
  const code = stripComments(source);
  const reads: Read[] = [];
  for (const m of code.matchAll(/[\w$\])]\.json\(\)/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = code.slice(Math.max(0, start - 200), start + 1);
    // The receiver (`res`, `r`, `response`) sits between the call's `(` and
    // `.json()`; strip it so VALIDATED sees what precedes the receiver.
    const head = before.replace(/[\w$.]+$/, "");
    if (VALIDATED.test(head)) continue;
    const after = code.slice(end, end + 40);
    const spelling: Spelling = CAST.test(after)
      ? "cast"
      : CAST_NEXT_LINE.test(after)
        ? "cast-next-line"
        : BARE_CAST.test(after)
          ? "bare-cast"
          : "uncast";
    reads.push({ line: code.slice(0, start).split("\n").length, spelling });
  }
  return reads;
}

/**
 * A production source file the gate reads: under `src/`, not a test, not the
 * vitest setup, not the vendored vodozemac build (which biome skips too).
 */
export function isProductionSource(path: string): boolean {
  return (
    path.startsWith("src/") &&
    /\.tsx?$/.test(path) &&
    !path.startsWith("src/__tests__/") &&
    !/\.(test|spec)\.tsx?$/.test(path) &&
    path !== "src/setupTests.ts" &&
    !path.startsWith("src/lib/e2e/vodozemac/")
  );
}

/** Every production source under `<root>/src`, as `src/…` paths, sorted. */
export function productionSources(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] => {
    const out: string[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };
  return walk(join(root, "src"), "src").filter(isProductionSource);
}

/** Each file's unvalidated reads; a file with none is absent. */
export function countReads(root: string, files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const n = unvalidatedReads(readFileSync(join(root, file), "utf8")).length;
    if (n > 0) counts.set(file, n);
  }
  return counts;
}

export type Verdict = {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly total: number;
};

/** Compare each file's count with the pin and the exclusions. Exact both ways. */
export function verdict(
  counts: ReadonlyMap<string, number>,
  pin: Readonly<Record<string, number>>,
  exclusions: Readonly<Record<string, { readonly count: number }>>,
): Verdict {
  const lines: string[] = [];
  let total = 0;
  const files = new Set([...counts.keys(), ...Object.keys(pin), ...Object.keys(exclusions)]);
  for (const file of [...files].sort()) {
    const found = counts.get(file) ?? 0;
    const excluded = exclusions[file]?.count ?? 0;
    if (excluded > 0 && found < excluded) {
      lines.push(
        `${file}: the exclusion names ${excluded} read(s) and ${found} remain — shrink it`,
      );
      continue;
    }
    const counted = found - excluded;
    const pinned = pin[file] ?? 0;
    total += counted;
    if (counted > pinned) {
      lines.push(
        `${file}: ${counted} unvalidated read(s), pinned at ${pinned} — validate the new one(s)`,
      );
    } else if (counted < pinned) {
      lines.push(
        `${file}: ${counted} unvalidated read(s), pinned at ${pinned} — lower the pin to ${counted}`,
      );
    }
  }
  return { ok: lines.length === 0, lines, total };
}

// Known answers, one per spelling and one per way the predicate could be
// wrong. Run by the CLI before any verdict (exit 3 when one fails) and by the
// unit test.
export const CONTROLS: ReadonlyArray<readonly [string, string, readonly Spelling[]]> = [
  ["cast on the same line", "const a = (await res.json()) as A;", ["cast"]],
  ["cast on the next line", "const b = (await res.json())\n  as B;", ["cast-next-line"]],
  ["bare cast", "const c = res.json() as Promise<C>;", ["bare-cast"]],
  ["returned uncast", "return await res.json();", ["uncast"]],
  ["validated by narrowRest", "return narrowRest(S_X, await res.json());", []],
  ["validated by a narrow helper", "return narrowThemeResponse(await res.json()).themes;", []],
  ["validated, receiver named response", "const v = narrowRest(S_Y, await response.json());", []],
  ["in a line comment", "// const d = (await res.json()) as D;", []],
  ["in a block comment", "/* (await res.json()) as E */", []],
  ["a json() that is not a read", "const s = toJson(x); JSON.stringify(y);", []],
  [
    "a narrow call elsewhere on the line does not validate",
    "narrowRest(S_X, a); const z = (await res.json()) as Z;",
    ["cast"],
  ],
];

export function runSelfTest(): string[] {
  const failures: string[] = [];
  for (const [name, source, expected] of CONTROLS) {
    const got = unvalidatedReads(source).map((r) => r.spelling);
    if (got.join(",") !== expected.join(",")) {
      failures.push(`${name}: expected [${expected.join(",")}], got [${got.join(",")}]`);
    }
  }
  return failures;
}
