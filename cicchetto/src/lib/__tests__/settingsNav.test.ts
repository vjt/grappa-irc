import { beforeEach, describe, expect, test } from "vitest";
import { consumePendingSettingsPage, requestSettingsPage } from "../settingsNav";

// settingsNav — one-shot deep-link target for the next SettingsDrawer
// open. The mobile footer themes button opens the drawer directly on the
// "themes" sub-page; the drawer consumes the request on its open
// transition. One-shot so a later plain open lands on "main".

describe("settingsNav", () => {
  beforeEach(() => {
    // Drain any residual request from a prior test.
    consumePendingSettingsPage();
  });

  test("consume returns the requested page then clears it (one-shot)", () => {
    requestSettingsPage("themes");
    expect(consumePendingSettingsPage()).toBe("themes");
    expect(consumePendingSettingsPage()).toBeNull();
  });

  test("consume with no pending request returns null", () => {
    expect(consumePendingSettingsPage()).toBeNull();
  });

  test("a later request overrides an unconsumed one", () => {
    requestSettingsPage("themes");
    requestSettingsPage("vhost");
    expect(consumePendingSettingsPage()).toBe("vhost");
  });
});
