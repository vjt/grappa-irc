import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { WireAdminEvent } from "../lib/api";

// M-11 — AdminEventsTab unit suite. The tab reads from `adminEvents()`
// (mocked here so each test seeds the signal directly). Per
// `feedback_no_silent_drops_closed`: one rendering assertion per
// kind so the exhaustive `renderEvent` switch in AdminEventsTab.tsx
// fails loudly on a missing arm. Per
// `feedback_no_localized_strings_server_side`: cic owns every
// human-readable string; tests assert the localized output here.

const sample = (overrides: Partial<WireAdminEvent>): WireAdminEvent =>
  ({ at: "2026-05-16T12:34:56Z", ...overrides }) as WireAdminEvent;

// Mutable mock store — each test assigns the array before render().
let events: WireAdminEvent[] = [];

vi.mock("../lib/adminEvents", () => ({
  adminEvents: () => events,
}));

import AdminEventsTab from "../AdminEventsTab";

describe("AdminEventsTab — empty state", () => {
  it("renders an empty-state message when there are no events", () => {
    events = [];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-events-tab")).toBeInTheDocument();
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
    expect(screen.getByText(/last 0 event/i)).toBeInTheDocument();
  });
});

describe("AdminEventsTab — per-kind rendering (closed-union exhaustiveness)", () => {
  it("circuit_open", () => {
    events = [
      sample({
        kind: "circuit_open",
        network_id: 1,
        network_slug: "azzurra",
        threshold: 3,
        cooldown_ms: 60_000,
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-circuit_open");
    expect(row.textContent).toContain("circuit OPEN for azzurra");
    expect(row.textContent).toContain("threshold=3");
    expect(row.textContent).toContain("cooldown=60000ms");
  });

  it("circuit_open falls back to net#<id> when slug is null", () => {
    events = [
      sample({
        kind: "circuit_open",
        network_id: 42,
        network_slug: null,
        threshold: 3,
        cooldown_ms: 60_000,
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-circuit_open").textContent).toContain("net#42");
  });

  it("circuit_close", () => {
    events = [
      sample({
        kind: "circuit_close",
        network_id: 1,
        network_slug: "azzurra",
        reason: "success",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-circuit_close").textContent).toContain(
      "circuit closed for azzurra",
    );
  });

  it("capacity_reject", () => {
    events = [
      sample({
        kind: "capacity_reject",
        flow: "bootstrap_visitor",
        error: "network_cap_exceeded",
        network_id: 1,
        network_slug: "azzurra",
        client_id: "abc-123",
      }),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-capacity_reject");
    expect(row.textContent).toContain("bootstrap_visitor flow rejected on azzurra");
    expect(row.textContent).toContain("network_cap_exceeded");
    expect(row.textContent).toContain("client abc-123");
  });

  it("visitor_deleted with actor", () => {
    events = [
      sample({
        kind: "visitor_deleted",
        visitor_id: "v-uuid",
        visitor_nick: "S`grappa",
        network_slug: "azzurra",
        actor_user_id: "u-uuid",
        actor_user_name: "vjt",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-visitor_deleted");
    expect(row.textContent).toContain("S`grappa deleted by vjt");
  });

  it("visitor_deleted without actor (system path)", () => {
    events = [
      sample({
        kind: "visitor_deleted",
        visitor_id: "v-uuid",
        visitor_nick: "anon",
        network_slug: null,
        actor_user_id: null,
        actor_user_name: null,
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-visitor_deleted");
    expect(row.textContent).toContain("anon deleted");
    expect(row.textContent).not.toContain("by ");
  });

  it("visitor_reaped", () => {
    events = [
      sample({
        kind: "visitor_reaped",
        visitor_id: "v-id",
        visitor_nick: "ghost",
        network_slug: "azzurra",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-visitor_reaped").textContent).toContain(
      "ghost reaped (TTL expired)",
    );
  });

  it("reaper_swept", () => {
    events = [sample({ kind: "reaper_swept", count: 5 } as WireAdminEvent)];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-reaper_swept").textContent).toContain(
      "reaper swept 5 visitor(s)",
    );
  });

  it("upload_reaped", () => {
    events = [
      sample({
        kind: "upload_reaped",
        upload_id: "up_abc",
        slug: "abc123",
        subject_kind: "user",
        subject_id: "u-uuid",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-upload_reaped").textContent).toContain(
      "upload abc123 reaped (user:u-uuid)",
    );
  });

  it("uploads_swept", () => {
    events = [sample({ kind: "uploads_swept", count: 3 } as WireAdminEvent)];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-uploads_swept").textContent).toContain(
      "uploads reaper swept 3 upload(s)",
    );
  });

  it("session_disconnected", () => {
    events = [
      sample({
        kind: "session_disconnected",
        subject_kind: "user",
        subject_id: "u-uuid",
        network_id: 1,
        network_slug: "azzurra",
        actor_user_id: "vjt-uuid",
        actor_user_name: "vjt",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-session_disconnected");
    expect(row.textContent).toContain("user:u-uuid @ azzurra disconnected by vjt");
  });

  it("session_terminated visitor variant", () => {
    events = [
      sample({
        kind: "session_terminated",
        subject_kind: "visitor",
        subject_id: "v-uuid",
        network_id: 1,
        network_slug: "azzurra",
        actor_user_id: "vjt-uuid",
        actor_user_name: "vjt",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-session_terminated").textContent).toContain(
      "visitor:v-uuid @ azzurra terminated by vjt",
    );
  });

  it("network_caps_updated with all three caps + actor", () => {
    events = [
      sample({
        kind: "network_caps_updated",
        network_id: 1,
        network_slug: "azzurra",
        max_concurrent_visitor_sessions: 100,
        max_concurrent_user_sessions: 50,
        max_per_client: 5,
        actor_user_id: "vjt-uuid",
        actor_user_name: "vjt",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const row = screen.getByTestId("admin-event-network_caps_updated");
    expect(row.textContent).toContain("azzurra caps: visitorSessions=100");
    expect(row.textContent).toContain("userSessions=50");
    expect(row.textContent).toContain("perClient=5");
    expect(row.textContent).toContain("by vjt");
  });

  it("network_caps_updated with nil caps renders ∞", () => {
    events = [
      sample({
        kind: "network_caps_updated",
        network_id: 1,
        network_slug: "azzurra",
        max_concurrent_visitor_sessions: null,
        max_concurrent_user_sessions: null,
        max_per_client: null,
        actor_user_id: null,
        actor_user_name: null,
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-network_caps_updated").textContent).toContain(
      "visitorSessions=∞",
    );
  });

  it("circuit_reset", () => {
    events = [
      sample({
        kind: "circuit_reset",
        network_id: 1,
        network_slug: "azzurra",
        actor_user_id: "vjt-uuid",
        actor_user_name: "vjt",
      } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    expect(screen.getByTestId("admin-event-circuit_reset").textContent).toContain(
      "circuit RESET for azzurra by vjt",
    );
  });
});

describe("AdminEventsTab — multi-row ordering", () => {
  it("renders newest-first ordering (signal order is the source of truth)", () => {
    events = [
      sample({ kind: "reaper_swept", count: 3 } as WireAdminEvent),
      sample({ kind: "reaper_swept", count: 2 } as WireAdminEvent),
      sample({ kind: "reaper_swept", count: 1 } as WireAdminEvent),
    ];
    render(() => <AdminEventsTab />);
    const rows = screen.getAllByTestId("admin-event-reaper_swept");
    expect(rows.length).toBe(3);
    expect(rows[0]?.textContent ?? "").toContain("swept 3");
    expect(rows[1]?.textContent ?? "").toContain("swept 2");
    expect(rows[2]?.textContent ?? "").toContain("swept 1");
    expect(screen.getByText(/last 3 event/i)).toBeInTheDocument();
  });
});
