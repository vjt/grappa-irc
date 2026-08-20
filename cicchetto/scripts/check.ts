#!/usr/bin/env bun
// The cic gate runner (#1469): every stage RUNS, and the verdict is the UNION
// of their failures.
//
// It replaces `"check": "biome check && tsc --noEmit && tsc --noEmit -p
// e2e/tsconfig.json"`. `&&` stopped at the first non-zero, so a red `check`
// said "the FIRST stage failed" and nothing at all about the rest — while
// reading, to a human, as "the gate ran and found a problem". Formatting is
// the cheapest and most frequent failure and it sat first in the chain, so it
// was the stage most likely to mask the expensive ones: measured three times
// in one day, hiding two, then three, genuine type errors for exactly as long
// as the cosmetic failure lasted.
//
// Measured on this branch with one mutant planted per stage — a format-only
// error, a `tsc` src type error, a `tsc` e2e type error: the old chain exited
// 1 and printed 456 lines naming NONE of the three broken files. Two because
// the two `tsc` passes never ran, the third because of the ceiling below.
//
// `--max-diagnostics=none`: biome's default is 20 and this tree already
// carries 59 warnings + 6 infos, so in that same measurement the ONE error was
// truncated away behind `Diagnostics not shown: 46`. A red that names no file
// is a red nobody can act on — the same lie one layer down, cured in the same
// place because it is the same command.
//
// Sequential, not parallel: three interleaved tool outputs cost more in
// attribution than they save in wall clock (biome is sub-second here; the
// `tsc` passes dominate and are CPU-bound anyway).
//
// A new stage is a new entry in STAGES and inherits the aggregation. That is
// the point of the array — the shape it replaces let a fourth stage be
// appended with the bug intact, and one forgotten `||` in a hand-rolled shell
// chain would have been worse still: a silent GREEN over a real failure.

type Stage = { readonly name: string; readonly argv: readonly string[] };

const STAGES: readonly Stage[] = [
  // First, and cheap: it says whether the three stages below are attributable
  // at all. #1571 measured a `node_modules` whose biome was three minor
  // versions off `bun.lock`, and nothing in the tree compared the two — the
  // only freshness test any script applied was `scripts/bun.sh`'s
  // `needs_install`, which asks whether the directory is EMPTY. It does not
  // short-circuit the rest: a stale toolchain and a real type error are
  // separate facts and #1469's whole point is reporting the union.
  { name: "lock drift (node_modules vs bun.lock)", argv: ["bun", "scripts/lock-drift.ts"] },
  { name: "biome (src + e2e)", argv: ["biome", "check", "--max-diagnostics=none"] },
  { name: "tsc (src)", argv: ["tsc", "--noEmit"] },
  { name: "tsc (e2e)", argv: ["tsc", "--noEmit", "-p", "e2e/tsconfig.json"] },
];

const results: { name: string; code: number }[] = [];

for (const stage of STAGES) {
  console.log(`\n━━━ ${stage.name} — ${stage.argv.join(" ")}`);
  let code: number;
  try {
    const proc = Bun.spawn([...stage.argv], { stdout: "inherit", stderr: "inherit" });
    await proc.exited;
    // null when the stage died on a signal: a failure, not a pass.
    code = proc.exitCode ?? 1;
  } catch (err) {
    // A stage whose binary is absent must not silently shrink the stage list —
    // that is the exact class of failure this runner exists to stop.
    console.error(`cannot run \`${stage.argv.join(" ")}\`: ${err}`);
    code = 127;
  }
  results.push({ name: stage.name, code });
}

const failed = results.filter((r) => r.code !== 0);

// The count is the honesty payload: "3 stages ran" is what tells a reader the
// red covers everything. Without it the next regression is invisible again.
console.log(`\n━━━ check summary — ${results.length} stages ran, ${failed.length} failed`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? "ok  " : "FAIL"}  ${r.name}${r.code === 0 ? "" : `  (exit ${r.code})`}`);
}

process.exit(failed.length === 0 ? 0 : 1);
