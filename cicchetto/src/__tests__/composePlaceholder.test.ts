import { describe, expect, it } from "vitest";
import { composePlaceholder } from "../lib/composePlaceholder";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #151 — the compose textarea placeholder leaked the internal `$server`
// window-name sentinel. composePlaceholder is the pure boundary that
// rejects it. Pure helper → no mocks.
describe("composePlaceholder (#151)", () => {
  it("labels the server window with the network slug, never the $server sentinel", () => {
    // Feed the production sentinel constant (not a "$server" literal that
    // could drift from windowKinds.ts) and a representative slug.
    const placeholder = composePlaceholder("freenode", SERVER_WINDOW_NAME);
    // The bug was the raw sentinel surfacing in the UI.
    expect(placeholder).not.toContain(SERVER_WINDOW_NAME);
    expect(placeholder).not.toContain("$");
    // Mirrors Sidebar's `⚙️ <slug>` server-window label.
    expect(placeholder).toBe("message freenode");
  });

  it("interpolates real IRC targets verbatim", () => {
    expect(composePlaceholder("freenode", "#grappa")).toBe("message #grappa");
    expect(composePlaceholder("freenode", "someNick")).toBe("message someNick");
  });

  it("never leaks ANY $-prefixed synthetic sentinel (general rule, not just $server)", () => {
    // A hypothetical future synthetic-window-with-compose: its sentinel
    // must not reach the placeholder even though no branch names it.
    expect(composePlaceholder("freenode", "$future")).not.toContain("$");
  });
});
