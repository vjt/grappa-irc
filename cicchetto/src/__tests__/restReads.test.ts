import { describe, expect, it } from "vitest";
import {
  CONTROLS,
  countReads,
  EXCLUSIONS,
  isProductionSource,
  PIN,
  productionSources,
  runSelfTest,
  unvalidatedReads,
  verdict,
} from "../../scripts/rest-reads-core";

// Issue 2694 — the ratchet on REST bodies read without validation. Every case
// is two-sided on purpose: a gate that only ever ran over a clean tree proves
// nothing about what it would catch, so each spelling is shown counted, each
// validated shape is shown NOT counted, and the verdict is shown red in every
// direction a count can move as well as green on the exact match.

const spellings = (source: string) => unvalidatedReads(source).map((r) => r.spelling);

describe("rest reads — the predicate sees every spelling of an unvalidated read", () => {
  it.each(CONTROLS.map(([name, source, expected]) => ({ name, source, expected })))(
    "$name",
    ({ source, expected }) => {
      expect(spellings(source)).toEqual(expected);
    },
  );

  it("the four spellings in one file count as four, on their own lines", () => {
    const source = [
      "const a = (await res.json()) as A;",
      "const b = (await res.json())",
      "  as B;",
      "const c = res.json() as Promise<C>;",
      "return await res.json();",
      "return narrowRest(S_X, await res.json());",
    ].join("\n");

    expect(unvalidatedReads(source)).toEqual([
      { line: 1, spelling: "cast" },
      { line: 2, spelling: "cast-next-line" },
      { line: 4, spelling: "bare-cast" },
      { line: 5, spelling: "uncast" },
    ]);
  });

  it("the self-test the CLI runs before any verdict passes", () => {
    expect(runSelfTest()).toEqual([]);
  });
});

describe("rest reads — which files are production", () => {
  it.each([
    ["src/lib/api.ts", true],
    ["src/Shell.tsx", true],
    ["src/service-worker.ts", true],
    ["src/__tests__/api.test.ts", false],
    ["src/lib/foo.test.ts", false],
    ["src/lib/foo.spec.tsx", false],
    ["src/setupTests.ts", false],
    ["src/lib/e2e/vodozemac/vodozemac_binding.d.ts", false],
    ["src/lib/api.js", false],
    ["e2e/tests/x.spec.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isProductionSource(path)).toBe(expected);
  });
});

describe("rest reads — the verdict is exact in both directions", () => {
  const PINNED = { "src/lib/a.ts": 2 };
  const EXCLUDED = { "src/lib/feed.ts": { count: 1 } };

  it("counts equal to the pin are green and the total is the pinned sum", () => {
    const got = verdict(
      new Map([
        ["src/lib/a.ts", 2],
        ["src/lib/feed.ts", 1],
      ]),
      PINNED,
      EXCLUDED,
    );

    expect(got).toEqual({ ok: true, lines: [], total: 2 });
  });

  it("a new read in a pinned file is red and says to validate it", () => {
    const got = verdict(
      new Map([
        ["src/lib/a.ts", 3],
        ["src/lib/feed.ts", 1],
      ]),
      PINNED,
      EXCLUDED,
    );

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/a.ts: 3 unvalidated read(s), pinned at 2 — validate the new one(s)",
    ]);
  });

  it("a read in a file the pin does not name is red: an absent file is pinned at 0", () => {
    const got = verdict(
      new Map([
        ["src/lib/a.ts", 2],
        ["src/lib/feed.ts", 1],
        ["src/lib/new.ts", 1],
      ]),
      PINNED,
      EXCLUDED,
    );

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/new.ts: 1 unvalidated read(s), pinned at 0 — validate the new one(s)",
    ]);
  });

  it("a cured read is red until the pin comes down with it, so the pin cannot go stale", () => {
    const got = verdict(
      new Map([
        ["src/lib/a.ts", 1],
        ["src/lib/feed.ts", 1],
      ]),
      PINNED,
      EXCLUDED,
    );

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/a.ts: 1 unvalidated read(s), pinned at 2 — lower the pin to 1",
    ]);
  });

  it("a file cured to zero is red too: its pin entry must go", () => {
    const got = verdict(new Map([["src/lib/feed.ts", 1]]), PINNED, EXCLUDED);

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/a.ts: 0 unvalidated read(s), pinned at 2 — lower the pin to 0",
    ]);
  });

  it("a second read in an excluded file counts against the pin, so an exclusion is not room", () => {
    const got = verdict(
      new Map([
        ["src/lib/a.ts", 2],
        ["src/lib/feed.ts", 2],
      ]),
      PINNED,
      EXCLUDED,
    );

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/feed.ts: 1 unvalidated read(s), pinned at 0 — validate the new one(s)",
    ]);
  });

  it("an exclusion that no longer matches is red: it must shrink rather than linger", () => {
    const got = verdict(new Map([["src/lib/a.ts", 2]]), PINNED, EXCLUDED);

    expect(got.ok).toBe(false);
    expect(got.lines).toEqual([
      "src/lib/feed.ts: the exclusion names 1 read(s) and 0 remain — shrink it",
    ]);
  });
});

describe("rest reads — the real tree", () => {
  it("every exclusion carries its reason", () => {
    for (const [file, { count, why }] of Object.entries(EXCLUSIONS)) {
      expect(count, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it("the production sources under src/ match the pin exactly (the stage's own verdict)", () => {
    const root = process.cwd();
    const files = productionSources(root);
    // A walk that found nothing would match a pin of nothing; the pin is not
    // nothing, and neither is the tree.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/lib/api.ts");

    const got = verdict(countReads(root, files), PIN, EXCLUSIONS);

    expect(got.lines).toEqual([]);
    expect(got.total).toBe(Object.values(PIN).reduce((a, b) => a + b, 0));
  });
});
