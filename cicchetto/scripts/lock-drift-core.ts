// #1571 — is what is INSTALLED what `bun.lock` pins?
//
// The pure half: no filesystem, no Bun API, no imports. `lock-drift.ts` does
// the IO and calls in here; `src/__tests__/lockDrift.test.ts` exercises both
// sides of every rule. Keeping it importable from `src` is also what puts it
// under `tsc --noEmit` — `cicchetto/scripts/` is outside both the tsconfig
// `include` and biome's `files.includes`, so a runner-only module would be
// checked by nothing.
//
// WHY THIS EXISTS. A gate verdict is only attributable if the tools that
// produced it are the ones the lockfile names. #1571 measured a checkout whose
// biome was three minor versions off the lock, and the failure mode is
// two-sided: a rule that only fires on the newer version passes locally and
// fails in CI, and a rule that only fires on the older one fails locally
// against code CI would accept. Nothing in the tree compared the two — the
// only freshness test any script applied was `scripts/bun.sh`'s
// `needs_install`, which asks whether `node_modules` is EMPTY. A populated but
// stale tree answered "installed" and was never reconciled, and the documented
// worktree procedure (`cp -Rc` the tree from the main checkout) copied
// whatever was there into every new worktree.
//
// WHY THE COMPARISON IS SCOPED TO THE EXECUTING PLATFORM. Tools like biome and
// rolldown ship as a JS wrapper plus one binary package per platform
// (`@biomejs/cli-darwin-arm64`, `@rolldown/binding-linux-arm64-gnu`, …), and
// `bun install` only ever resolves the optional dependency matching the
// platform it runs on. Every gate in this repo runs `bun` inside a linux
// container (`scripts/bun.sh`), so the darwin binaries in a macOS developer's
// tree cannot be refreshed by any path the project uses — measured on
// 2026-08-20: `@biomejs/cli-darwin-arm64` at 2.4.13 against a lock pinning
// 2.5.8, its directory dated three months before its linux siblings. Comparing
// those would make the gate red on something no gate executes and no
// documented command can fix. So the question this asks is narrower and
// truthful: does what will RUN HERE match the lock. The stale foreign-platform
// binaries are a documented limitation, recorded in docs/TESTING.md.

/** npm `os` / `cpu` fields: a list of allowed values, or `!value` exclusions. */
export type PlatformConstraint = readonly string[] | null;

export type InstalledPackage = {
  readonly name: string;
  readonly version: string;
  readonly os: PlatformConstraint;
  readonly cpu: PlatformConstraint;
};

/** `process.platform` / `process.arch` of whoever is running the gate. */
export type Platform = { readonly os: string; readonly cpu: string };

export type DriftRow = { readonly name: string; readonly lock: string; readonly installed: string };

export type Report = {
  /** installed packages whose name the lock resolves, and that run here. */
  readonly compared: number;
  readonly drift: readonly DriftRow[];
  /** installed for a platform that is not this one — deliberately not judged. */
  readonly skippedPlatform: number;
  /** installed, runs here, and the lock has no entry for the name. */
  readonly notInLock: number;
  /** direct dependencies of package.json that the comparison never reached. */
  readonly uncovered: readonly string[];
};

/**
 * Resolve every `"name@version"` the lockfile carries, keyed by name.
 *
 * `bun.lock` is JSONC — it has trailing commas, so `JSON.parse` refuses it.
 * Rather than hand-roll a JSONC parser, read the one token whose shape is
 * stable across every lockfile version: each entry's value is an array whose
 * FIRST element is the canonical `name@version`. Parsing the value rather than
 * the key also sidesteps bun's nested `parent/child` keys and scoped names in
 * one rule.
 *
 * A name can resolve at several versions (a transitive duplicate), so the map
 * holds a list and a match against ANY of them is not drift: which one a given
 * consumer sees is a hoisting decision, not a pin violation.
 */
export function parseLockVersions(lockText: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of lockText.matchAll(/\["([^"\n]+)"/g)) {
    const token = match[1];
    if (token === undefined) continue;
    // Scoped names carry a leading `@`, so split on the LAST one.
    const at = token.lastIndexOf("@");
    if (at <= 0) continue;
    const name = token.slice(0, at);
    const version = token.slice(at + 1);
    if (name === "" || version === "") continue;
    const seen = out.get(name);
    if (seen === undefined) out.set(name, [version]);
    else if (!seen.includes(version)) seen.push(version);
  }
  return out;
}

/**
 * npm platform matching: an empty/absent list matches everything, a list of
 * `!value` entries excludes, anything else is an allowlist.
 */
export function matchesPlatform(constraint: PlatformConstraint, value: string): boolean {
  if (constraint === null || constraint.length === 0) return true;
  const negated = constraint.filter((entry) => entry.startsWith("!"));
  if (negated.length === constraint.length) {
    return !negated.some((entry) => entry.slice(1) === value);
  }
  return constraint.some((entry) => entry === value);
}

export function runsHere(pkg: InstalledPackage, platform: Platform): boolean {
  return matchesPlatform(pkg.os, platform.os) && matchesPlatform(pkg.cpu, platform.cpu);
}

/**
 * Classify an installed tree against the lock.
 *
 * `required` is the direct dependency + devDependency names from package.json.
 * Any of them the comparison never reached is reported as `uncovered` — the
 * one completeness check that can be made without guessing: it catches both a
 * partial install and a parser that silently stopped resolving names, and it
 * cannot false-positive on the lock's many entries for other platforms.
 */
export function classify(
  installed: readonly InstalledPackage[],
  lock: ReadonlyMap<string, readonly string[]>,
  platform: Platform,
  required: readonly string[],
): Report {
  const drift: DriftRow[] = [];
  const reached = new Set<string>();
  let compared = 0;
  let skippedPlatform = 0;
  let notInLock = 0;

  for (const pkg of installed) {
    if (!runsHere(pkg, platform)) {
      skippedPlatform += 1;
      reached.add(pkg.name);
      continue;
    }
    const versions = lock.get(pkg.name);
    if (versions === undefined || versions.length === 0) {
      notInLock += 1;
      continue;
    }
    compared += 1;
    reached.add(pkg.name);
    if (!versions.includes(pkg.version)) {
      drift.push({ name: pkg.name, lock: versions.join(","), installed: pkg.version });
    }
  }

  drift.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    compared,
    drift,
    skippedPlatform,
    notInLock,
    uncovered: required.filter((name) => !reached.has(name)).sort(),
  };
}

/**
 * The verdict, kept apart from the numbers so a caller cannot read one without
 * the other. `compared === 0` is a FAILURE, not a clean tree: it is what an
 * instrument that measured nothing looks like, and it is the shape every
 * silent zero in this repo's history has taken.
 */
export function verdict(report: Report): { ok: boolean; reason: string | null } {
  if (report.compared === 0) {
    return { ok: false, reason: "compared 0 packages — the comparison measured nothing" };
  }
  if (report.uncovered.length > 0) {
    return { ok: false, reason: `direct dependencies never compared: ${report.uncovered.join(", ")}` };
  }
  if (report.drift.length > 0) {
    return { ok: false, reason: `${report.drift.length} package(s) installed off-lock` };
  }
  return { ok: true, reason: null };
}

export function formatReport(report: Report): string {
  const lines = [
    `compared=${report.compared} drift=${report.drift.length} ` +
      `skipped_other_platform=${report.skippedPlatform} not_in_lock=${report.notInLock}`,
  ];
  for (const row of report.drift) {
    lines.push(`  DRIFT ${row.name}  lock=${row.lock}  installed=${row.installed}`);
  }
  return lines.join("\n");
}

const LINUX: Platform = { os: "linux", cpu: "arm64" };

function pkg(
  name: string,
  version: string,
  os: PlatformConstraint = null,
  cpu: PlatformConstraint = null,
): InstalledPackage {
  return { name, version, os, cpu };
}

/**
 * Known-answer controls, run by the gate BEFORE it reports any real number.
 * A failed control exits without numbers: a comparator nobody has calibrated
 * produces a zero indistinguishable from "nothing drifted".
 *
 * Returns the failures; empty means every control answered as expected.
 */
export function runSelfTest(): string[] {
  const failures: string[] = [];
  const expect = (label: string, actual: unknown, wanted: unknown): void => {
    const a = JSON.stringify(actual);
    const w = JSON.stringify(wanted);
    if (a !== w) failures.push(`${label}: expected ${w}, got ${a}`);
  };

  // 1 — the parser, on a lockfile fragment with the trailing commas that make
  //     `JSON.parse` refuse the real file, a scoped name, and a duplicate.
  const parsed = parseLockVersions(`{
  "packages": {
    "foo": ["foo@1.0.0", "", {}, "sha512-a=="],
    "@scope/bar": ["@scope/bar@2.0.0", "", {}, "sha512-b=="],
    "dup/foo": ["foo@1.2.0", "", {}, "sha512-c=="],
  }
}`);
  expect("parse/plain", parsed.get("foo"), ["1.0.0", "1.2.0"]);
  expect("parse/scoped", parsed.get("@scope/bar"), ["2.0.0"]);
  expect("parse/absent", parsed.get("nope"), undefined);

  const lock = new Map<string, string[]>([
    ["foo", ["1.0.0"]],
    ["@scope/bar", ["2.0.0"]],
    ["multi", ["1.1.5", "1.2.1"]],
    ["@tool/cli-darwin-arm64", ["2.5.8"]],
  ]);

  // 2 — the positive control: one aligned package, one deliberately off-lock,
  //     one the lock does not carry. The drifted one must be NAMED.
  const mixed = classify(
    [pkg("foo", "1.0.0"), pkg("@scope/bar", "1.9.9"), pkg("orphan", "0.0.1")],
    lock,
    LINUX,
    ["foo", "@scope/bar"],
  );
  expect("mixed/compared", mixed.compared, 2);
  expect("mixed/drift", mixed.drift, [{ name: "@scope/bar", lock: "2.0.0", installed: "1.9.9" }]);
  expect("mixed/notInLock", mixed.notInLock, 1);
  expect("mixed/uncovered", mixed.uncovered, []);
  expect("mixed/verdict", verdict(mixed).ok, false);

  // 3 — a version among a multi-resolution lock entry is not drift.
  const multi = classify([pkg("multi", "1.2.1")], lock, LINUX, []);
  expect("multi/drift", multi.drift, []);
  expect("multi/verdict", verdict(multi).ok, true);

  // 4 — THE PLATFORM RULE, and the reason the darwin binaries are a
  //     limitation rather than a red: a package that cannot run here is
  //     skipped, not compared, even though its version is off-lock.
  const foreign = classify(
    [pkg("@tool/cli-darwin-arm64", "2.4.13", ["darwin"], ["arm64"]), pkg("foo", "1.0.0")],
    lock,
    LINUX,
    [],
  );
  expect("foreign/skipped", foreign.skippedPlatform, 1);
  expect("foreign/compared", foreign.compared, 1);
  expect("foreign/drift", foreign.drift, []);
  //     …and the same package IS judged on the platform it belongs to, or the
  //     skip would be a blanket exemption instead of a scoping rule.
  const native = classify(
    [pkg("@tool/cli-darwin-arm64", "2.4.13", ["darwin"], ["arm64"])],
    lock,
    { os: "darwin", cpu: "arm64" },
    [],
  );
  expect("native/drift", native.drift.length, 1);

  // 5 — an empty tree must FAIL, not pass: zero compared is the instrument
  //     measuring nothing.
  expect("empty/verdict", verdict(classify([], lock, LINUX, [])).ok, false);

  // 6 — a declared dependency the walk never reached is named.
  const gap = classify([pkg("foo", "1.0.0")], lock, LINUX, ["foo", "ghost"]);
  expect("gap/uncovered", gap.uncovered, ["ghost"]);
  expect("gap/verdict", verdict(gap).ok, false);

  return failures;
}
