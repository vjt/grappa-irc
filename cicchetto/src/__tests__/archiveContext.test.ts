import { beforeEach, describe, expect, it } from "vitest";

// UX-5 bucket BM (2026-05-20) — `archiveSlugForSelection` lifted from
// ShellChrome's inline `archiveSlug()`. Both the standalone chrome
// archive button (ShellChrome) and the mobile members drawer archive
// launcher (Shell.tsx) gate on this predicate. The "no archive
// affordance on home / mentions / admin / pre-select" rule lives here
// so a future window kind only requires one edit.

let mockSelected: {
  networkSlug: string;
  channelName: string;
  kind: "channel" | "query" | "server" | "home" | "mentions" | "admin";
} | null = null;

vi.mock("../lib/selection", () => ({
  selectedChannel: () => mockSelected,
  applySeedEnvelope: vi.fn(),
}));

import { vi } from "vitest";
import { archiveSlugForSelection } from "../lib/archiveContext";

beforeEach(() => {
  mockSelected = null;
});

describe("archiveSlugForSelection", () => {
  it("returns null when no window is selected", () => {
    mockSelected = null;
    expect(archiveSlugForSelection()).toBeNull();
  });

  it("returns null on home", () => {
    mockSelected = { networkSlug: "$home", channelName: "$home", kind: "home" };
    expect(archiveSlugForSelection()).toBeNull();
  });

  it("returns null on mentions", () => {
    mockSelected = { networkSlug: "freenode", channelName: "$mentions", kind: "mentions" };
    expect(archiveSlugForSelection()).toBeNull();
  });

  it("returns null on admin", () => {
    mockSelected = { networkSlug: "$admin", channelName: "$admin", kind: "admin" };
    expect(archiveSlugForSelection()).toBeNull();
  });

  it("returns the network slug for a channel window", () => {
    mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
    expect(archiveSlugForSelection()).toBe("freenode");
  });

  it("returns the network slug for a query (DM) window", () => {
    mockSelected = { networkSlug: "freenode", channelName: "alice", kind: "query" };
    expect(archiveSlugForSelection()).toBe("freenode");
  });

  it("returns the network slug for a server window", () => {
    mockSelected = { networkSlug: "freenode", channelName: "$server", kind: "server" };
    expect(archiveSlugForSelection()).toBe("freenode");
  });
});
