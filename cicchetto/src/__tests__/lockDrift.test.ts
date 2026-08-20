import { describe, expect, it } from "vitest";
import {
  classify,
  type InstalledPackage,
  matchesPlatform,
  type Platform,
  parseLockVersions,
  runSelfTest,
  verdict,
} from "../../scripts/lock-drift-core";

// #1571 — the gate that says whether `node_modules` is what `bun.lock` pins.
// Every case below is two-sided on purpose: the rule is only worth anything if
// the red side reddens AND the green side stays green under the same
// comparator, so a mutation that disables the check cannot pass by making
// everything green (nor by making everything red).

const LINUX: Platform = { os: "linux", cpu: "arm64" };
const DARWIN: Platform = { os: "darwin", cpu: "arm64" };

const pkg = (
  name: string,
  version: string,
  os: readonly string[] | null = null,
  cpu: readonly string[] | null = null,
): InstalledPackage => ({ name, version, os, cpu });

const LOCK = new Map<string, string[]>([
  ["biome-ish", ["2.5.8"]],
  ["@tool/cli-darwin-arm64", ["2.5.8"]],
  ["@tool/cli-linux-arm64", ["2.5.8"]],
  ["multi", ["1.1.5", "1.2.1"]],
]);

describe("lock drift — the installed tree against bun.lock", () => {
  it("an aligned tree compares its packages and stays green", () => {
    const report = classify([pkg("biome-ish", "2.5.8")], LOCK, LINUX, ["biome-ish"]);

    expect(report.compared).toBe(1);
    expect(report.drift).toEqual([]);
    expect(verdict(report).ok).toBe(true);
  });

  it("a package installed off-lock reddens and is named with both versions", () => {
    const report = classify([pkg("biome-ish", "2.4.13")], LOCK, LINUX, ["biome-ish"]);

    expect(report.compared).toBe(1);
    expect(report.drift).toEqual([{ name: "biome-ish", lock: "2.5.8", installed: "2.4.13" }]);
    expect(verdict(report).ok).toBe(false);
  });

  it("a name the lock resolves at several versions matches any of them", () => {
    // A transitive duplicate is a hoisting outcome, not a pin violation.
    expect(classify([pkg("multi", "1.1.5")], LOCK, LINUX, []).drift).toEqual([]);
    expect(classify([pkg("multi", "1.2.1")], LOCK, LINUX, []).drift).toEqual([]);
    expect(classify([pkg("multi", "1.0.0")], LOCK, LINUX, []).drift).toHaveLength(1);
  });
});

describe("lock drift — the platform scoping, which is what makes the darwin binaries a limitation", () => {
  const darwinBinary = pkg("@tool/cli-darwin-arm64", "2.4.13", ["darwin"], ["arm64"]);

  it("skips a binary that cannot run here, even though its version is off-lock", () => {
    const report = classify([darwinBinary, pkg("biome-ish", "2.5.8")], LOCK, LINUX, []);

    expect(report.skippedPlatform).toBe(1);
    expect(report.compared).toBe(1);
    expect(report.drift).toEqual([]);
    expect(verdict(report).ok).toBe(true);
  });

  it("judges the very same package on the platform it belongs to", () => {
    // Without this side the skip would be a blanket exemption: the rule is
    // "what runs HERE", not "platform binaries are never checked".
    const report = classify([darwinBinary], LOCK, DARWIN, []);

    expect(report.skippedPlatform).toBe(0);
    expect(report.drift).toEqual([
      { name: "@tool/cli-darwin-arm64", lock: "2.5.8", installed: "2.4.13" },
    ]);
  });

  it("reads npm allowlists and negations the way npm does", () => {
    expect(matchesPlatform(null, "linux")).toBe(true);
    expect(matchesPlatform([], "linux")).toBe(true);
    expect(matchesPlatform(["linux", "darwin"], "linux")).toBe(true);
    expect(matchesPlatform(["darwin"], "linux")).toBe(false);
    expect(matchesPlatform(["!win32"], "linux")).toBe(true);
    expect(matchesPlatform(["!win32"], "win32")).toBe(false);
  });
});

describe("lock drift — the ways the comparison can measure nothing", () => {
  it("fails on an empty comparison instead of reporting a clean tree", () => {
    const report = classify([], LOCK, LINUX, []);

    expect(report.compared).toBe(0);
    expect(report.drift).toEqual([]);
    // The dangerous shape: zero drift over zero comparisons. It must not pass.
    expect(verdict(report).ok).toBe(false);
    expect(verdict(report).reason).toContain("measured nothing");
  });

  it("names a declared dependency the walk never reached", () => {
    const report = classify([pkg("biome-ish", "2.5.8")], LOCK, LINUX, ["biome-ish", "ghost"]);

    expect(report.uncovered).toEqual(["ghost"]);
    expect(verdict(report).ok).toBe(false);
  });

  it("counts an installed package the lock does not carry without failing on it", () => {
    // Not a pin violation: `bun install --cwd e2e` and stray local installs
    // both land here, and calling them drift would make the gate cry wolf.
    const report = classify([pkg("biome-ish", "2.5.8"), pkg("stray", "0.0.1")], LOCK, LINUX, []);

    expect(report.notInLock).toBe(1);
    expect(verdict(report).ok).toBe(true);
  });
});

describe("lock drift — the lockfile parser", () => {
  const text = `{
  "packages": {
    "plain": ["plain@1.0.0", "", {}, "sha512-a=="],
    "@scope/tool": ["@scope/tool@2.5.8", "", { "os": "linux" }, "sha512-b=="],
    "nested/plain": ["plain@1.2.0", "", {}, "sha512-c=="],
  }
}`;

  it("resolves scoped names, and survives the trailing commas JSON.parse refuses", () => {
    expect(() => JSON.parse(text)).toThrow();

    const lock = parseLockVersions(text);
    expect(lock.get("@scope/tool")).toEqual(["2.5.8"]);
    expect(lock.get("plain")).toEqual(["1.0.0", "1.2.0"]);
    expect(lock.get("absent")).toBeUndefined();
  });
});

describe("lock drift — the controls the gate runs on itself", () => {
  it("answers every known-answer control before it reports a number", () => {
    // The gate exits 3 without printing numbers when this list is non-empty.
    expect(runSelfTest()).toEqual([]);
  });
});
