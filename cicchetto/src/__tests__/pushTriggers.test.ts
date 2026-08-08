import { describe, expect, it } from "vitest";
import { type ShouldNotifyMessage, shouldNotify } from "../lib/pushTriggers";
import truthTable from "../lib/shouldNotifyTruthTable.json";
import type { NotificationPrefs } from "../lib/userSettings";

// PWA icon badge (2026-06-21) — `shouldNotify` is the foreground mirror
// of `Grappa.Push.Triggers.should_notify?/5`. This suite drives it with
// the SHARED truth-table fixture (`shouldNotifyTruthTable.json`) that the
// ExUnit `Grappa.Push.ShouldNotifyParityTest` also consumes. The two
// suites running the identical cases is the drift gate: add a branch →
// add a row → both pick it up. If this and the Elixir side ever
// disagree, one of them fails on the shared row.

type TruthCase = {
  name: string;
  message: ShouldNotifyMessage;
  network_slug: string;
  own_nick: string;
  prefs: NotificationPrefs;
  patterns: string[];
  expected: boolean;
};

const cases = truthTable as TruthCase[];

describe("shouldNotify — shared truth-table parity with should_notify?/5", () => {
  it("the shared fixture is non-empty (guards an accidental empty array)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of cases) {
    it(c.name, () => {
      // #1038 — `network_slug` comes from the case, never a constant: the
      // fixture carries cases that differ ONLY in the slug, and a hardcoded
      // one here would make them indistinguishable on this port while the
      // ExUnit side still told them apart.
      expect(shouldNotify(c.message, c.network_slug, c.own_nick, c.prefs, c.patterns)).toBe(
        c.expected,
      );
    });
  }
});
