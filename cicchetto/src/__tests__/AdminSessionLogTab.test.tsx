import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLogWireT } from "../lib/wireTypes";

// #215 — AdminSessionLogTab unit suite. The tab fetches a REST
// snapshot on mount (`adminListSessionLog`) AND merges the live
// `sessionLogEvents()` signal (deduped by id, newest-first) so new
// lifecycle events appear without a refetch. Per
// `feedback_no_localized_strings_server_side` the server emits
// structured data only; this component owns ALL human-readable
// strings — the tests assert the localized output here.

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListSessionLog: vi.fn(),
  };
});

// Mutable live-signal mock — each test assigns the array before render()
// (mirror of AdminEventsTab.test.tsx's `adminEvents: () => events`).
let liveEntries: SessionLogWireT[] = [];
vi.mock("../lib/sessionLog", () => ({
  sessionLogEvents: () => liveEntries,
}));

import AdminSessionLogTab from "../AdminSessionLogTab";

let nextId = 0;
const entry = (overrides: Partial<SessionLogWireT>): SessionLogWireT => {
  nextId += 1;
  return {
    id: nextId,
    session_id: "sess-11112222",
    event: "connected",
    subject_kind: "user",
    network_id: 1,
    network_slug: "azzurra",
    nick: "vjt",
    reason: null,
    clean: null,
    duration_ms: null,
    delay_ms: null,
    attempt: null,
    at: "2026-07-15T12:00:00Z",
    ...overrides,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  liveEntries = [];
  nextId = 0;
});

describe("AdminSessionLogTab — empty state", () => {
  it("renders the container + an empty-state message when there are no entries", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([]);

    render(() => <AdminSessionLogTab />);

    expect(screen.getByTestId("admin-session-log-tab")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/no session log entries/i)).toBeInTheDocument();
    });
    expect(api.adminListSessionLog).toHaveBeenCalledWith("test-bearer");
  });
});

describe("AdminSessionLogTab — per-kind rendering", () => {
  it("renders a row for every event kind from the REST snapshot", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([
      entry({ event: "backoff", delay_ms: 5000, attempt: 3 }),
      entry({ event: "disconnected", clean: false, reason: "Ping timeout", duration_ms: 5000 }),
      entry({ event: "deidentified" }),
      entry({ event: "identified" }),
      entry({ event: "registered" }),
      entry({ event: "connected" }),
    ]);

    render(() => <AdminSessionLogTab />);

    await waitFor(() => {
      expect(screen.getByTestId("session-log-row-connected")).toBeInTheDocument();
    });
    expect(screen.getByTestId("session-log-row-registered")).toBeInTheDocument();
    expect(screen.getByTestId("session-log-row-identified")).toBeInTheDocument();
    expect(screen.getByTestId("session-log-row-deidentified")).toBeInTheDocument();
    expect(screen.getByTestId("session-log-row-disconnected")).toBeInTheDocument();
    expect(screen.getByTestId("session-log-row-backoff")).toBeInTheDocument();
  });

  it("disconnected row shows the reason, clean flag, and duration", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([
      entry({ event: "disconnected", clean: false, reason: "Ping timeout", duration_ms: 5000 }),
    ]);

    render(() => <AdminSessionLogTab />);

    const row = await screen.findByTestId("session-log-row-disconnected");
    expect(row.textContent).toContain("Ping timeout");
    expect(row.textContent).toContain("5s");
    expect(row.textContent?.toLowerCase()).toContain("unclean");
  });

  it("backoff row shows the delay + attempt count", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([
      entry({ event: "backoff", delay_ms: 8000, attempt: 4 }),
    ]);

    render(() => <AdminSessionLogTab />);

    const row = await screen.findByTestId("session-log-row-backoff");
    expect(row.textContent).toContain("8000");
    expect(row.textContent).toContain("4");
  });

  it("renders the session_id + nick on a row", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([
      entry({ event: "connected", nick: "S`grappa", session_id: "sess-deadbeef" }),
    ]);

    render(() => <AdminSessionLogTab />);

    const row = await screen.findByTestId("session-log-row-connected");
    expect(row.textContent).toContain("S`grappa");
    expect(row.textContent).toContain("sess-deadbeef");
  });
});

describe("AdminSessionLogTab — REST + live merge", () => {
  it("merges the live signal with the REST snapshot, deduped by id, newest-first", async () => {
    const snapshotRow = entry({ id: 100, event: "connected", nick: "old-conn" });
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessionLog).mockResolvedValue([snapshotRow]);

    // Live: a brand-new event (id 101) PLUS a duplicate of the snapshot row
    // (id 100, same event) — the dedupe must keep exactly one id-100.
    liveEntries = [
      entry({ id: 101, event: "disconnected", clean: true, reason: "quit" }),
      { ...snapshotRow },
    ];

    render(() => <AdminSessionLogTab />);

    await waitFor(() => {
      expect(screen.getByTestId("session-log-row-disconnected")).toBeInTheDocument();
    });

    // One connected row (dedupe), one disconnected row.
    expect(screen.getAllByTestId("session-log-row-connected").length).toBe(1);
    expect(screen.getAllByTestId("session-log-row-disconnected").length).toBe(1);

    // Newest-first: the live id-101 disconnected row precedes the id-100
    // connected snapshot row in DOM order.
    const rows = screen.getAllByTestId(/^session-log-row-/);
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute("data-testid")).toBe("session-log-row-disconnected");
    expect(rows[1]?.getAttribute("data-testid")).toBe("session-log-row-connected");
  });
});
