import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

let mockWindowState: Record<string, string> = {};

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

import ComposeBox from "../ComposeBox";

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowState = {};
});

describe("ComposeBox", () => {
  it("renders a textarea + send button with channel placeholder", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("typing fires compose.setDraft", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    fireEvent.input(screen.getByPlaceholderText(/message #a/i), {
      target: { value: "hi" },
    });
    expect(compose.setDraft).toHaveBeenCalled();
  });

  it("Enter (no shift) submits", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(compose.submit).toHaveBeenCalledWith(expect.anything(), "freenode", "#a");
  });

  it("Shift+Enter inserts a newline (does NOT submit)", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(compose.submit).not.toHaveBeenCalled();
  });

  it("Up arrow on first-line cursor calls recallPrev", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(compose.recallPrev).toHaveBeenCalled();
  });

  it("Down arrow on last-line cursor calls recallNext", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(compose.recallNext).toHaveBeenCalled();
  });

  it("error from submit renders an alert banner", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ error: "unknown command: /whois" });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/unknown command/i);
  });

  it("'empty' error from submit does NOT render the alert banner", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ error: "empty" });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    // Wait a tick for the async submit to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("textarea retains focus after a successful submit", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    ta.focus();
    expect(document.activeElement).toBe(ta);
    fireEvent.keyDown(ta, { key: "Enter" });
    // Wait for the async submit to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(ta);
  });

  it("textarea has no `disabled` attribute (regression guard for focus loss)", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    expect(ta.hasAttribute("disabled")).toBe(false);
  });

  // CP15 B5: greyed-state visual when window state is failed/kicked/parked.
  // The form root gets `.compose-box-greyed`; an inline "(not joined)"
  // label sits beneath the textarea. Compose stays functional — the
  // operator can still type `/join` / `/part`. The visual cue tells
  // them their typing won't reach the channel without a re-join.
  it("renders .compose-box-greyed when state=failed", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders .compose-box-greyed when state=kicked", () => {
    mockWindowState = { "freenode #a": "kicked" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders .compose-box-greyed when state=parked", () => {
    mockWindowState = { "freenode #a": "parked" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders the '(not joined)' label when state=failed", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    expect(screen.getByText(/\(not joined\)/i)).toBeInTheDocument();
  });

  it("does NOT render .compose-box-greyed when state=joined", () => {
    mockWindowState = { "freenode #a": "joined" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("does NOT render .compose-box-greyed when state=pending", () => {
    // Pending = JOIN in flight. Compose stays normal; the operator
    // typed JOIN and is awaiting the upstream echo.
    mockWindowState = { "freenode #a": "pending" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("does NOT render .compose-box-greyed for query windows (no state entry)", () => {
    // Query windows (DMs) have no window-state entry — they're always
    // "live" (no JOIN gate). Absence of the entry must not grey the
    // compose box, otherwise every DM looks broken.
    mockWindowState = {};
    render(() => <ComposeBox networkSlug="freenode" channelName="vjt" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("compose textarea remains functional when greyed (operator can still type /join)", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    expect(ta.hasAttribute("disabled")).toBe(false);
  });
});
