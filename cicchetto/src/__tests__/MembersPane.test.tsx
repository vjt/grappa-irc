import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({
    "freenode #italia": [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ],
  }),
  loadMembers: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import MembersPane from "../MembersPane";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MembersPane", () => {
  it("renders members with mode-tier classes", () => {
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const op = document.querySelector(".member-op");
    expect(op?.textContent).toContain("vjt");
    const voiced = document.querySelector(".member-voiced");
    expect(voiced?.textContent).toContain("alice");
    const plain = document.querySelector(".member-plain");
    expect(plain?.textContent).toContain("bob");
  });

  it("renders the count in the heading", () => {
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/members \(3\)/i)).toBeInTheDocument();
  });

  it("calls loadMembers on first render", async () => {
    const m = await import("../lib/members");
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(m.loadMembers).toHaveBeenCalledWith("freenode", "#italia");
  });

  it("renders 'no members yet' fallback when list is empty", () => {
    render(() => <MembersPane networkSlug="freenode" channelName="#empty" />);
    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  });
});
