#!/usr/bin/env bun
// #1571 — the `bun run check` stage that makes the other stages attributable:
// it answers whether the tools about to produce a verdict are the ones
// `bun.lock` pins. The rules, the platform scoping and the reasoning live in
// `./lock-drift-core.ts`; this file is only the IO around them.
//
// Exit codes are distinct on purpose:
//   0  every package that runs here matches the lock
//   1  drift, or a declared dependency the comparison never reached
//   3  a known-answer control failed — NO numbers are printed, because a
//      comparator that cannot answer a question with a known answer cannot be
//      believed when it answers one without.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classify, formatReport, parseLockVersions, runSelfTest, verdict } from "./lock-drift-core";

const root = process.cwd();

const failures = runSelfTest();
if (failures.length > 0) {
  console.error("lock-drift: SELF-TEST FAILED — refusing to report numbers");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(3);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return null;
}

function readInstalled(dir: string, name: string) {
  const manifest = readJson(join(dir, "package.json"));
  if (manifest === null || typeof manifest.version !== "string") return null;
  return {
    name,
    version: manifest.version,
    os: stringList(manifest.os),
    cpu: stringList(manifest.cpu),
  };
}

function walk(modulesDir: string) {
  const out = [];
  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = readdirSync(join(modulesDir, entry));
      } catch {
        continue;
      }
      for (const inner of scoped.sort()) {
        const pkg = readInstalled(join(modulesDir, entry, inner), `${entry}/${inner}`);
        if (pkg !== null) out.push(pkg);
      }
      continue;
    }
    const pkg = readInstalled(join(modulesDir, entry), entry);
    if (pkg !== null) out.push(pkg);
  }
  return out;
}

let lockText: string;
try {
  lockText = readFileSync(join(root, "bun.lock"), "utf8");
} catch {
  console.error(`lock-drift: no bun.lock at ${root} — cannot attribute anything`);
  process.exit(1);
}

const manifest = readJson(join(root, "package.json")) ?? {};
const required = [
  ...Object.keys((manifest.dependencies as Record<string, string>) ?? {}),
  ...Object.keys((manifest.devDependencies as Record<string, string>) ?? {}),
];

const platform = { os: process.platform, cpu: process.arch };
const report = classify(walk(join(root, "node_modules")), parseLockVersions(lockText), platform, required);
const result = verdict(report);

console.log(`lock-drift: ${platform.os}/${platform.cpu} — ${formatReport(report)}`);

if (!result.ok) {
  console.error(`lock-drift: ${result.reason}`);
  console.error(
    "lock-drift: the tree does not match bun.lock, so any verdict from the stages below is " +
      "not attributable to the code. Reconcile with `scripts/bun.sh install --frozen-lockfile`.",
  );
  process.exit(1);
}
