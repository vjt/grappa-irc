#!/usr/bin/env bun
// Issue 2694 — the `bun run check` stage that holds the line on REST bodies
// read without validation: every production `.json()` read that is not the
// direct argument of a `narrow*` call. The predicate, the pin, the exclusions
// and the reasoning live in `./rest-reads-core.ts`; this file is only the IO
// around them.
//
// Exit codes follow `lock-drift.ts`:
//   0  every file's count equals its pin
//   1  a count moved — UP (validate the new read) or DOWN (lower the pin)
//   3  a known-answer control failed, or the walk found nothing — NO verdict is
//      printed, because a counter that cannot answer a question with a known
//      answer cannot be believed when it answers one without.
import {
  countReads,
  EXCLUSIONS,
  PIN,
  productionSources,
  runSelfTest,
  verdict,
} from "./rest-reads-core";

const failures = runSelfTest();
if (failures.length > 0) {
  console.error("rest-reads: SELF-TEST FAILED — refusing to report a verdict");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(3);
}

const root = process.cwd();
const files = productionSources(root);

if (files.length === 0) {
  console.error("rest-reads: found NO production sources under src/ — the walk cannot be believed");
  process.exit(3);
}

const counts = countReads(root, files);
const result = verdict(counts, PIN, EXCLUSIONS);

// The per-file counts and the total are the honesty payload, same argument as
// `test-location.ts`: a green says nothing unless it also says how many reads
// it saw and in how many files it looked.
for (const [file, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  const why = EXCLUSIONS[file]?.why;
  console.log(
    `  ${String(n).padStart(3)}  ${file}${why === undefined ? "" : `  (excluded: ${why})`}`,
  );
}
console.log(
  `rest-reads: ${files.length} production sources, ${result.total} unvalidated REST read(s) ` +
    `(pinned ${Object.values(PIN).reduce((a, b) => a + b, 0)})`,
);

if (!result.ok) {
  for (const line of result.lines) console.error(`  ${line}`);
  console.error(
    "rest-reads: the count of REST bodies read without a schema moved (issue 2694). A NEW read " +
      "validates through `narrowRest(S_…, await res.json())` (or a `narrow*` helper built on it); a " +
      "read you just cured lowers its file's entry in PIN (scripts/rest-reads-core.ts) in the same commit.",
  );
  process.exit(1);
}
