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

// After one of these words a `/` opens a regex literal; after any other word,
// a number or a closing bracket it divides.
const REGEX_AFTER_WORD = new Set(
  "await case delete do else in instanceof new of return throw typeof void yield".split(" "),
);

const regexMayStart = (out: readonly string[], at: number): boolean => {
  let j = at - 1;
  while (j >= 0 && /\s/.test(out[j] ?? "")) j--;
  if (j < 0) return true;
  if (/[\w$]/.test(out[j] ?? "")) {
    let k = j;
    while (k > 0 && /[\w$]/.test(out[k - 1] ?? "")) k--;
    return REGEX_AFTER_WORD.has(out.slice(k, j + 1).join(""));
  }
  return !/[)\]}"'`]/.test(out[j] ?? "");
};

/**
 * Blank out comments and the contents of string, template and regex literals,
 * keeping every newline (so line numbers survive) and every delimiter. A
 * comment opener inside a literal (`"image/*"`, `"https://…"`) is text, and a
 * `${…}` inside a template is code again. JSX text is not lexed: a quote that
 * reaches the end of its line opened no string, and is left as it is.
 *
 * Throws on a block comment or template literal that never closes. TypeScript
 * compiles neither, so on a real tree that is this lexer misreading something,
 * and blanking to the end of the file would hide every read after it.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const lineAt = (at: number): number => source.slice(0, at).split("\n").length;
  // One counter per open `${`: the `{` it has opened inside, innermost last.
  const open: number[] = [];

  // Template text from `from` to the closing backtick or to the next `${`.
  const templateText = (from: number): number => {
    for (let k = from; k < n; k++) {
      if (source[k] === "\\") k++;
      else if (source[k] === "`") {
        blank(from, k);
        return k + 1;
      } else if (source[k] === "$" && source[k + 1] === "{") {
        blank(from, k);
        open.push(0);
        return k + 2;
      }
    }
    throw new Error(`a template literal opened on line ${lineAt(from)} never closes`);
  };

  // A quoted string or a regex literal: neither crosses a line, so one that
  // reaches a newline was not one, and `at` is left as code.
  const literal = (at: number, regex: boolean): number => {
    let inClass = false;
    for (let k = at + 1; k < n; k++) {
      const ch = source[k];
      if (ch === "\\") k++;
      else if (ch === "\n") return at + 1;
      else if (regex && ch === "[") inClass = true;
      else if (regex && ch === "]") inClass = false;
      else if (ch === source[at] && !inClass) {
        blank(at + 1, k);
        return k + 1;
      }
    }
    return at + 1;
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      blank(i, end);
      i = end;
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) throw new Error(`a block comment opened on line ${lineAt(i)} never closes`);
      blank(i, close + 2);
      i = close + 2;
    } else if (c === "'" || c === '"') {
      i = literal(i, false);
    } else if (c === "/" && regexMayStart(out, i)) {
      i = literal(i, true);
    } else if (c === "`") {
      i = templateText(i + 1);
    } else if (c === "}" && open.at(-1) === 0) {
      open.pop();
      i = templateText(i + 1);
    } else {
      const top = open.length - 1;
      if (top >= 0 && (c === "{" || c === "}")) open[top] = (open[top] ?? 0) + (c === "{" ? 1 : -1);
      i++;
    }
  }
  return out.join("");
}

// The read is VALIDATED when it is the direct argument of a call whose callee
// starts with `narrow`: `narrowRest(S_X, await res.json())`,
// `narrowThemeResponse(await res.json())`. Measured: every one of the 60
// validated reads on `9d52a9e45` has exactly that shape. The look-behind is
// what "starts with" means: `unnarrow(` does not validate.
const VALIDATED = /(?<![\w$])narrow\w*\((?:[^()]*,)?\s*(?:await\s+)?$/;

const CAST = /^\)[ \t]+as\s/;
const CAST_NEXT_LINE = /^\)[ \t]*\n\s*as\s/;
const BARE_CAST = /^\s+as\s/;

/** Every `.json()` read in `source` that no `narrow*` call validates. */
export function unvalidatedReads(source: string): Read[] {
  const code = blankNonCode(source);
  const reads: Read[] = [];
  // The receiver ends in a name, a bracket or a non-null `!`, and reaches
  // `json` through `.` or `?.`.
  for (const m of code.matchAll(/[\w$\])!]\??\.json\(\)/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = code.slice(Math.max(0, start - 200), start + 1);
    // The receiver (`res`, `r`, `response`) sits between the call's `(` and
    // `.json()`; strip it so VALIDATED sees what precedes the receiver.
    const head = before.replace(/[\w$.!]+$/, "");
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

/**
 * Each file's unvalidated reads; a file with none is absent. Throws, naming the
 * file, when one cannot be lexed.
 */
export function countReads(root: string, files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    let n: number;
    try {
      n = unvalidatedReads(readFileSync(join(root, file), "utf8")).length;
    } catch (e) {
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  [
    "a callee that only contains narrow does not validate",
    "const v = unnarrow(await res.json());",
    ["uncast"],
  ],
  ["optional-chained receiver", "const a = (await res?.json()) as A;", ["cast"]],
  ["non-null receiver", "const a = (await res!.json()) as A;", ["cast"]],
  // A comment opener inside a literal is not a comment. Each of these blinded
  // the text-level stripper to the read beside it, so each errs GREEN if the
  // lexer forgets a literal kind.
  [
    "a MIME wildcard in a string on the read's own line",
    'const accept = "image/*"; const a = (await res.json()) as A; /* why */',
    ["cast"],
  ],
  [
    "a MIME wildcard in a string on the line above",
    'const accept = "image/*";\nconst a = (await res.json()) as A;\n/* note */',
    ["cast"],
  ],
  ["a URL in a string", 'const u = "https://x"; const a = (await res.json()) as A;', ["cast"]],
  [
    "a URL in a template literal",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the control is a template literal, as text
    "const u = `https://${host}/api`; const a = (await res.json()) as A;",
    ["cast"],
  ],
  [
    "a URL in a regex literal",
    "const re = /https?:\\/\\//; const a = (await res.json()) as A;",
    ["cast"],
  ],
  [
    "a regex literal after return",
    "return /^https?:\\/\\//.test(u) || (await res.json()) as A;",
    ["cast"],
  ],
  [
    "a division is not a regex literal",
    "const r = a / b; const a = (await res.json()) as A; const s = c / d;",
    ["cast"],
  ],
  [
    "a read inside a template expression is code",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the control is a template literal, as text
    "log(`got ${(await res.json()) as A}`);",
    ["cast"],
  ],
  ["a .json() inside a string is not a read", 'const m = "res.json() as A failed";', []],
  [
    "a quote that opens no string (JSX text) costs nothing past its line",
    "<p>Don't</p>\nconst a = (await res.json()) as A; const b = 'x';",
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
