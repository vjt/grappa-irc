import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdminCredential,
  AdminNetwork,
  AdminSession,
  AdminSessionLogEntry,
  AdminVisitor,
} from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListVisitors: vi.fn(),
    adminListCredentials: vi.fn(),
    adminListSessions: vi.fn(),
    adminListNetworks: vi.fn(),
    adminListSessionLogSessions: vi.fn(),
    adminDisconnectSession: vi.fn(),
    adminReconnectSession: vi.fn(),
    adminTerminateSession: vi.fn(),
    adminDeleteVisitor: vi.fn(),
  };
});

import AdminSessionsTab from "../AdminSessionsTab";

// #1157 — the unified Sessions tab. The Visitors tab is gone and this
// one lists both subject kinds, ACTIVE AND INACTIVE.
//
// The property most of these tests are really defending is that the
// list is row-backed: /admin/sessions only ever returns live pids, so
// every assertion below about a parked or pid-less row is an assertion
// that the merge did NOT get rebuilt on the registry.

const VISITOR_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const LIVE = {
  nick: "vjt",
  alive: true,
  pid_inspect: "#PID<0.123.0>",
  mailbox_len: 3,
  memory_bytes: 250_000,
  joined_channels: ["#bofh", "#italia"],
  introspection_degraded: [],
};

const NETWORK = {
  id: 1,
  slug: "azzurra",
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_ip: null,
  live_counts: { visitors: 0, users: 0 },
} as unknown as AdminNetwork;

const parkedVisitor = (over: Partial<AdminVisitor> = {}): AdminVisitor =>
  ({
    id: VISITOR_ID,
    expires_at: "2099-01-01T00:00:00Z",
    identified: false,
    ip: "1.2.3.4",
    inserted_at: "2026-05-16T00:00:00Z",
    last_seen_at: null,
    networks: [
      {
        network_slug: "azzurra",
        network_id: 1,
        nick: "guest1",
        connection_state: "parked",
        live_state: null,
      },
    ],
    ...over,
  }) as AdminVisitor;

const userCredential = (over: Partial<AdminCredential> = {}): AdminCredential =>
  ({
    user_id: USER_ID,
    network_id: 1,
    network_slug: "azzurra",
    nick: "vjt",
    ident: null,
    realname: null,
    sasl_user: null,
    auth_method: "sasl",
    auth_command_template: null,
    autojoin_channels: [],
    last_joined_channels: [],
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-05-16T00:00:00Z",
    updated_at: "2026-05-16T00:00:00Z",
    last_seen_at: "2026-08-10T00:00:00Z",
    live_state: LIVE,
    ...over,
  }) as AdminCredential;

const userSession = (): AdminSession =>
  ({
    subject_kind: "user",
    subject_id: USER_ID,
    subject_label: "vjt",
    last_seen_at: "2026-08-10T00:00:00Z",
    network_id: 1,
    live_state: {
      ...LIVE,
      peer_address: "2a01:4f8:201:2281:11::22",
      peer_port: 6697,
      peer_name: "allnight6.azzurra.chat",
    },
  }) as AdminSession;

const VISITOR_KEY = `visitor:${VISITOR_ID}:1`;
const USER_KEY = `user:${USER_ID}:1`;

const GONE_VISITOR_ID = "33333333-3333-3333-3333-333333333333";
const GONE_KEY = `visitor:${GONE_VISITOR_ID}:1`;

const logEntry = (over: Partial<AdminSessionLogEntry> = {}): AdminSessionLogEntry =>
  ({
    id: 7,
    session_id: GONE_KEY,
    event: "disconnected",
    subject_kind: "visitor",
    network_id: 1,
    network_slug: "azzurra",
    nick: "guest9",
    old_nick: null,
    reason: ":tcp_closed",
    clean: false,
    duration_ms: 3_600_000,
    delay_ms: null,
    attempt: null,
    at: "2026-08-10T10:00:00Z",
    ...over,
  }) as AdminSessionLogEntry;

async function mountWith(over: {
  visitors?: AdminVisitor[];
  credentials?: AdminCredential[];
  sessions?: AdminSession[];
  logSessions?: AdminSessionLogEntry[];
}) {
  const api = await import("../lib/api");
  vi.mocked(api.adminListVisitors).mockResolvedValue(over.visitors ?? []);
  vi.mocked(api.adminListCredentials).mockResolvedValue(over.credentials ?? []);
  vi.mocked(api.adminListSessions).mockResolvedValue(over.sessions ?? []);
  vi.mocked(api.adminListNetworks).mockResolvedValue([NETWORK]);
  vi.mocked(api.adminListSessionLogSessions).mockResolvedValue(over.logSessions ?? []);
  render(() => <AdminSessionsTab />);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminSessionsTab — inactive sessions are listed (#1157)", () => {
  // THE regression this tab exists to prevent. A parked visitor has no
  // registry entry, so /admin/sessions is empty here: if the row shows
  // up anyway, the list is row-backed.
  it("renders a parked visitor even though /admin/sessions is empty", async () => {
    await mountWith({ visitors: [parkedVisitor()], sessions: [] });

    expect(await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`)).toBeTruthy();
  });

  it("renders a parked user credential even though /admin/sessions is empty", async () => {
    await mountWith({
      credentials: [userCredential({ connection_state: "parked", live_state: null })],
      sessions: [],
    });

    expect(await screen.findByTestId(`admin-session-row-${USER_KEY}`)).toBeTruthy();
  });

  it("lists both subject kinds in one table", async () => {
    await mountWith({ visitors: [parkedVisitor()], credentials: [userCredential()] });

    await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`);
    expect(screen.getByTestId(`admin-session-row-${USER_KEY}`)).toBeTruthy();
  });
});

describe("AdminSessionsTab — the dictated columns", () => {
  it("shows the subject kind and the nick in the identity cell", async () => {
    await mountWith({ credentials: [userCredential()] });

    const row = await screen.findByTestId(`admin-session-row-${USER_KEY}`);
    expect(row.textContent).toContain("user");
    expect(row.textContent).toContain("vjt");
  });

  it("shows the network under the nick", async () => {
    await mountWith({ credentials: [userCredential()] });

    const row = await screen.findByTestId(`admin-session-row-${USER_KEY}`);
    expect(row.textContent).toContain("azzurra");
  });

  // #1223 item 1 — and it shows it ONCE. The panel used to carry a
  // `network` fact as well, so the slug was printed twice on every row,
  // at EVERY width: this half of the report is JSX duplication, not the
  // `.adm-col-detail` specificity defect the other tabs have, and no CSS
  // change would have touched it.
  it("does not repeat the network in the drill-down", async () => {
    await mountWith({ credentials: [userCredential()] });

    const row = await screen.findByTestId(`admin-session-row-${USER_KEY}`);
    expect(
      row.querySelector(".admin-session-network")?.textContent,
      "pre-state: the identity cell is where the network is printed",
    ).toBe("azzurra");

    fireEvent.click(screen.getByTestId(`admin-session-details-${USER_KEY}`));
    const panel = await screen.findByTestId(`admin-session-detail-${USER_KEY}`);

    const factValues = [...panel.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(factValues, "the panel must not reprint what the row already shows").not.toContain(
      "azzurra",
    );
  });

  it("renders the channel count from the live session", async () => {
    await mountWith({ credentials: [userCredential()] });

    const cell = await screen.findByTestId(`admin-session-channels-${USER_KEY}`);
    expect(cell).toHaveTextContent("2");
  });

  // An unknown count is not zero: "0" would read as a connected session
  // sitting in no channels, which is a different and actionable fact.
  it("renders an em-dash, NOT 0, when there is no live session", async () => {
    await mountWith({ visitors: [parkedVisitor()] });

    const cell = await screen.findByTestId(`admin-session-channels-${VISITOR_KEY}`);
    expect(cell).toHaveTextContent("—");
    expect(cell).not.toHaveTextContent("0");
  });

  it("renders a question mark when introspection timed out on a live row", async () => {
    await mountWith({
      credentials: [userCredential({ live_state: { ...LIVE, joined_channels: null } })],
    });

    const cell = await screen.findByTestId(`admin-session-channels-${USER_KEY}`);
    expect(cell).toHaveTextContent("?");
  });

  // The reason last_seen_at was added to the row-backed wires: without
  // it this cell could only ever be an em-dash on an inactive row.
  it("renders last seen on a row with no live session", async () => {
    await mountWith({
      visitors: [parkedVisitor({ last_seen_at: new Date(Date.now() - 3_600_000).toISOString() })],
    });

    const cell = await screen.findByTestId(`admin-session-last-seen-${VISITOR_KEY}`);
    expect(cell).toHaveTextContent("1h");
  });

  it("says no browser session on record when last_seen_at is null", async () => {
    await mountWith({ visitors: [parkedVisitor({ last_seen_at: null })] });

    const cell = await screen.findByTestId(`admin-session-last-seen-${VISITOR_KEY}`);
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveAttribute("title", "no browser session on record");
  });
});

describe("AdminSessionsTab — actions differ by subject kind", () => {
  it("offers Disconnect and Terminate on a user row", async () => {
    await mountWith({ credentials: [userCredential()] });

    expect(await screen.findByTestId(`admin-session-disconnect-${USER_KEY}`)).toBeTruthy();
    expect(screen.getByTestId(`admin-session-terminate-${USER_KEY}`)).toBeTruthy();
  });

  // Reconnect is visitor-only on the server (`ensure_visitor_subject/1`
  // answers 400 for a user), so rendering it here would be a button
  // that cannot work.
  it("never offers Reconnect on a user row", async () => {
    await mountWith({ credentials: [userCredential({ live_state: null })] });

    await screen.findByTestId(`admin-session-row-${USER_KEY}`);
    expect(screen.queryByTestId(`admin-session-reconnect-${USER_KEY}`)).toBeNull();
  });

  it("offers Reconnect on a visitor with no live session", async () => {
    await mountWith({ visitors: [parkedVisitor()] });

    expect(await screen.findByTestId(`admin-session-reconnect-${VISITOR_KEY}`)).toBeTruthy();
  });

  it("offers Disconnect on a live visitor", async () => {
    const liveVisitor = parkedVisitor({
      networks: [
        {
          network_slug: "azzurra",
          network_id: 1,
          nick: "guest1",
          connection_state: "connected",
          live_state: LIVE,
        },
      ],
    });
    await mountWith({ visitors: [liveVisitor] });

    expect(await screen.findByTestId(`admin-session-disconnect-${VISITOR_KEY}`)).toBeTruthy();
  });

  it("two-step confirm fires the verb with the composite row key", async () => {
    const api = await mountWith({ credentials: [userCredential()] });

    const btn = await screen.findByTestId(`admin-session-disconnect-${USER_KEY}`);
    fireEvent.click(btn);
    expect(api.adminDisconnectSession).not.toHaveBeenCalled();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.adminDisconnectSession).toHaveBeenCalledWith("test-bearer", USER_KEY),
    );
  });

  it("arming one row disarms the other", async () => {
    await mountWith({ visitors: [parkedVisitor()], credentials: [userCredential()] });

    const userBtn = await screen.findByTestId(`admin-session-disconnect-${USER_KEY}`);
    const visitorBtn = screen.getByTestId(`admin-session-reconnect-${VISITOR_KEY}`);

    fireEvent.click(userBtn);
    expect(userBtn).toHaveTextContent("Confirm disconnect");

    fireEvent.click(visitorBtn);
    expect(userBtn).toHaveTextContent("Disconnect");
    expect(visitorBtn).toHaveTextContent("Confirm reconnect");
  });

  it("prefixes a failed verb with which verb failed", async () => {
    const api = await mountWith({ credentials: [userCredential()] });
    vi.mocked(api.adminTerminateSession).mockRejectedValue(new Error("boom"));

    const btn = await screen.findByTestId(`admin-session-terminate-${USER_KEY}`);
    fireEvent.click(btn);
    fireEvent.click(btn);

    const banner = await screen.findByTestId("admin-sessions-error");
    expect(banner).toHaveTextContent("terminate:");
  });
});

describe("AdminSessionsTab — Delete is identity-wide and lives behind the drill-down", () => {
  // The footgun this placement removes: DELETE /admin/visitors/:id kills
  // the whole identity, but a row here is one (subject, network) pair,
  // so a two-network visitor shows two rows. In the actions cell each
  // would silently destroy the other.
  it("does not put Delete in the row's actions cell", async () => {
    await mountWith({ visitors: [parkedVisitor()] });

    await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`);
    expect(screen.queryByTestId(`admin-session-delete-${VISITOR_KEY}`)).toBeNull();
  });

  it("reveals Delete, named for what it destroys, in the drill-down", async () => {
    await mountWith({ visitors: [parkedVisitor()] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${VISITOR_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${VISITOR_KEY}`);
    expect(panel).toHaveTextContent("deletes the whole visitor identity, on every network");
    expect(screen.getByTestId(`admin-session-delete-${VISITOR_KEY}`)).toBeTruthy();
  });

  it("has no Delete at all on a user row — there is no such verb", async () => {
    await mountWith({ credentials: [userCredential()] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${USER_KEY}`));

    await screen.findByTestId(`admin-session-detail-${USER_KEY}`);
    expect(screen.queryByTestId(`admin-session-delete-${USER_KEY}`)).toBeNull();
  });

  it("two-step Delete calls the identity-wide verb with the visitor id", async () => {
    const api = await mountWith({ visitors: [parkedVisitor()] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${VISITOR_KEY}`));
    const btn = await screen.findByTestId(`admin-session-delete-${VISITOR_KEY}`);

    fireEvent.click(btn);
    expect(api.adminDeleteVisitor).not.toHaveBeenCalled();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.adminDeleteVisitor).toHaveBeenCalledWith("test-bearer", VISITOR_ID),
    );
  });
});

describe("AdminSessionsTab — the drill-down keeps both sources of truth", () => {
  it("shows DB intent and live pid separately when they disagree", async () => {
    // The U-0 divergence: the credential still says connected, the BEAM
    // has no pid. Deriving one from the other would erase the signal.
    await mountWith({ credentials: [userCredential({ live_state: null })] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${USER_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${USER_KEY}`);
    expect(panel).toHaveTextContent("connected");
    expect(panel).toHaveTextContent("BEAM has no pid");
  });

  it("shows the upstream peer joined from /admin/sessions", async () => {
    await mountWith({ credentials: [userCredential()], sessions: [userSession()] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${USER_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${USER_KEY}`);
    expect(panel).toHaveTextContent("allnight6.azzurra.chat");
  });

  it("shows visitor-only facts on a visitor row", async () => {
    await mountWith({ visitors: [parkedVisitor()] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${VISITOR_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${VISITOR_KEY}`);
    expect(panel).toHaveTextContent("1.2.3.4");
  });
});

// #1158 item 4 gave a session whose subject is gone a row in this list,
// badged `deleted`, because the lifecycle log carries no FK to the
// subject and outlived the CASCADE. #1224 moved it OUT: three of the four
// dictated columns are live-process facts, so on those rows they were an
// em-dash forever. vjt's ruling (2026-08-11): a sub-page of Sessions with
// the record's own columns, no badge, and this list strictly live.
//
// The operator must still be able to SEE the session, and the surface
// must still never pretend the subject is there — the two properties
// #1158 item 4 established. Only the screen they hold on has changed.
describe("AdminSessionsTab — a session whose subject was deleted (#1224)", () => {
  it("keeps it out of the live list", async () => {
    await mountWith({ visitors: [parkedVisitor()], logSessions: [logEntry()] });

    // The live row is the pre-state: without it an empty table would
    // satisfy this by accident.
    await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`);
    expect(screen.queryByTestId(`admin-session-row-${GONE_KEY}`)).toBeNull();
  });

  it("carries no deleted badge anywhere, because nothing needs marking", async () => {
    await mountWith({ visitors: [parkedVisitor()], logSessions: [logEntry()] });

    await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`);
    expect(screen.queryByTestId(`admin-session-gone-${GONE_KEY}`)).toBeNull();
  });

  it("counts it on the door to the sub-page", async () => {
    await mountWith({ logSessions: [logEntry()] });

    const door = await screen.findByTestId("admin-sessions-ended-open");
    expect(door).toHaveTextContent("Ended sessions (1)");
  });

  // The door has to be reachable exactly when the live list is empty —
  // that is when an operator looking for a session that is over has
  // nothing else on screen.
  it("offers the door even with no live session at all", async () => {
    await mountWith({ logSessions: [logEntry()] });

    await screen.findByTestId("admin-sessions-empty");
    expect(screen.getByTestId("admin-sessions-ended-open")).toBeTruthy();
  });

  it("lists it on the sub-page with the record's own columns", async () => {
    await mountWith({ logSessions: [logEntry()] });

    fireEvent.click(await screen.findByTestId("admin-sessions-ended-open"));

    const row = await screen.findByTestId(`admin-ended-session-row-${GONE_KEY}`);
    expect(row.textContent).toContain("guest9");
    expect(row.textContent).toContain("disconnected");
    expect(row.textContent).toContain(":tcp_closed");
    expect(row.textContent).toContain("unclean");
    expect(row.textContent).toContain("1h0m");
  });

  // Point 3 of the ruling: not a blocker, still true. A page named after
  // a population implies it holds all of it, and this one cannot.
  it("says on the page that the ring is not an archive", async () => {
    await mountWith({ logSessions: [logEntry()] });

    fireEvent.click(await screen.findByTestId("admin-sessions-ended-open"));

    const card = await screen.findByTestId("admin-ended-sessions-card");
    expect(card).toHaveTextContent("not evidence the session never ran");
  });

  // An empty page is "the ring remembers nothing", never "no session
  // ended" — so it says so, and the caveat above it still applies.
  it("does not claim nothing ever ended when the log is empty", async () => {
    await mountWith({ credentials: [userCredential()], logSessions: [] });

    fireEvent.click(await screen.findByTestId("admin-sessions-ended-open"));

    const empty = await screen.findByTestId("admin-ended-sessions-empty");
    expect(empty).toHaveTextContent("the log remembers no session whose subject is gone");
  });

  it("goes back to the live list", async () => {
    await mountWith({ visitors: [parkedVisitor()], logSessions: [logEntry()] });

    fireEvent.click(await screen.findByTestId("admin-sessions-ended-open"));
    await screen.findByTestId("admin-ended-sessions-page");
    expect(screen.queryByTestId(`admin-session-row-${VISITOR_KEY}`)).toBeNull();

    fireEvent.click(screen.getByTestId("admin-ended-sessions-back"));

    expect(await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`)).toBeTruthy();
  });

  it("joins the last event onto a subject that still exists", async () => {
    await mountWith({
      credentials: [userCredential()],
      logSessions: [logEntry({ session_id: USER_KEY, subject_kind: "user", event: "connected" })],
    });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${USER_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${USER_KEY}`);
    expect(panel).toHaveTextContent("connected");
    expect(panel).toHaveTextContent("2026-08-10T10:00:00Z");
  });

  // The ring is global, bounded and written from an async cast. An empty
  // log is forgetfulness, not proof — and the panel must not imply it is.
  it("does not claim a session never ran when the log has nothing", async () => {
    await mountWith({ credentials: [userCredential()], logSessions: [] });

    fireEvent.click(await screen.findByTestId(`admin-session-details-${USER_KEY}`));

    const panel = await screen.findByTestId(`admin-session-detail-${USER_KEY}`);
    expect(panel).toHaveTextContent("nothing logged");
    expect(panel).toHaveTextContent("not proof it never ran");
  });
});

describe("AdminSessionsTab — load and failure", () => {
  it("renders the empty state when every source is empty", async () => {
    await mountWith({});

    expect(await screen.findByTestId("admin-sessions-empty")).toBeTruthy();
  });

  it("collapses the whole table when any one endpoint fails", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([parkedVisitor()]);
    vi.mocked(api.adminListCredentials).mockRejectedValue(new Error("boom"));
    vi.mocked(api.adminListSessions).mockResolvedValue([]);
    vi.mocked(api.adminListNetworks).mockResolvedValue([NETWORK]);
    vi.mocked(api.adminListSessionLogSessions).mockResolvedValue([]);

    render(() => <AdminSessionsTab />);

    await screen.findByTestId("admin-sessions-error");
    // A half-built merge is worse than no table: the operator cannot
    // tell which half is missing.
    expect(screen.queryByTestId("admin-sessions-table")).toBeNull();
  });

  // Deliberate, and the rule's hardest case: a dropped session-log fetch
  // would remove exactly the deleted-subject rows and leave a table that
  // looks complete. A missing ENTRY is forgetfulness; a missing FETCH is
  // a failure, and the two must not render the same.
  it("collapses the table when the session-log fetch fails, rather than hiding rows", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([parkedVisitor()]);
    vi.mocked(api.adminListCredentials).mockResolvedValue([]);
    vi.mocked(api.adminListSessions).mockResolvedValue([]);
    vi.mocked(api.adminListNetworks).mockResolvedValue([NETWORK]);
    vi.mocked(api.adminListSessionLogSessions).mockRejectedValue(new Error("boom"));

    render(() => <AdminSessionsTab />);

    await screen.findByTestId("admin-sessions-error");
    expect(screen.queryByTestId("admin-sessions-table")).toBeNull();
  });
});
