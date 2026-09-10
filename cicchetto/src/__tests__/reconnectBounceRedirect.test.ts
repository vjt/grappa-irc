// issue 2059 — the `/reconnect` bounce loses the home redirect when the park
// is shorter than the GET that would have shown it.
//
// `issue1796-reconnect-bounces-network.spec.ts` has been red 17 times since
// 2026-08 across branches that do not touch this path, and was tracked as a
// flake. It is not one: the spec asserts the operator ends on Home, and the
// product genuinely fails to put them there.
//
// WHY THE STORES BELOW ARE REAL AND THE BENCH IS NOT IN `selection.test.ts`:
// bucket D lives in `selection.ts` but is FED by `userTopic.ts`, and the
// defect is precisely a disagreement between what the event says and what the
// refetch it triggers ends up showing. A bench that calls `refetchNetworks()`
// by hand — which is what the existing bucket-D suite does — cannot express
// it, because the event never enters the picture. So this file mounts the
// real `userTopic` dispatcher over the real `selection` + `networks` stores,
// the way `userTopic-rotation.test.ts` does, and mocks only the two
// boundaries: the socket (to inject events) and REST.
//
// THE RACE, stated as the mock encodes it: `/reconnect` parks and immediately
// reconnects. Both legs emit `connection_state_changed` and each triggers a
// `refetchNetworks()`. A GET issued at the park leg does not necessarily
// OBSERVE the park — by the time the server answers it, the credential can
// already read `connected` again. `listNetworks` therefore returns
// `connected` on EVERY call here. That is not a contrived stub: it is what a
// park shorter than one round-trip looks like from the client, and it is the
// measured signature of the flake (the store never held `parked`).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmGraph } from "./helpers/warmGraph";

const channelMock = vi.hoisted(() => {
  const handlers: Array<(payload: { kind: string; [k: string]: unknown }) => void> = [];
  return {
    handlers,
    on: vi.fn((event: string, fn: (payload: { kind: string; [k: string]: unknown }) => void) => {
      if (event === "event") handlers.push(fn);
    }),
    leave: vi.fn(),
    fireEvent: (payload: { kind: string; [k: string]: unknown }) => {
      for (const h of handlers) h(payload);
    },
    reset: () => {
      handlers.length = 0;
    },
  };
});

// `onJoinOk` is deliberately NOT invoked: it hydrates highlights and
// notification prefs over REST, which this bench does not stub and does not
// assert on. Calling it only buys an unhandled `fetch() URL is invalid` in
// the output — noise that would sit next to a real failure and be read as
// part of it.
vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => ({ on: channelMock.on, leave: channelMock.leave })),
  joinChannel: vi.fn(() => ({ on: vi.fn(), leave: vi.fn() })),
}));

const NET_SLUG = "azzurra";
const CHANNEL = "#italia";

// Pass-through override rather than a full factory: the graph under test
// pulls in `tagNetwork` / `ownNickForNetwork` / the kind predicates, and a
// hand-written twin of those would be a second implementation to keep in
// step. Only the three REST calls are stubbed.
vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // ALWAYS connected — see "THE RACE" above. The park is never visible to
    // a refetch, which is the whole point of the bench.
    listNetworks: vi.fn().mockResolvedValue([
      {
        kind: "user",
        id: 1,
        slug: NET_SLUG,
        nick: "vjt",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    postPart: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
    }),
    login: vi.fn(),
    logout: vi.fn(),
    setOn401Handler: vi.fn(),
  };
});

// Same shape the server emits and `userTopic.test.ts` already pins.
const connectionStateChanged = (from: string, to: "connected" | "parked" | "failed") => ({
  kind: "connection_state_changed",
  user_id: "u1",
  network_id: 1,
  network_slug: NET_SLUG,
  from,
  to,
  reason: to === "connected" ? null : "rolling a fresh vhost",
  at: "2026-09-10T00:00:00Z",
  network: {
    slug: NET_SLUG,
    nick: "vjt",
    connection_state: to,
    connection_state_reason: to === "connected" ? null : "rolling a fresh vhost",
    connection_state_changed_at: "2026-09-10T00:00:00Z",
    recoverable: false,
  },
});

// #781 — warm the graph outside the per-test budget. See helpers/warmGraph.ts.
beforeAll(() => warmGraph(() => import("../lib/userTopic")));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  channelMock.reset();
  channelMock.on.mockClear();
});

const seedIdentity = (token: string) => {
  localStorage.setItem("grappa-token", token);
  localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user", id: "u1", name: "vjt" }));
};

// Bring the graph up with the operator sitting in a channel of the live
// network, and the user-topic dispatcher installed. Returns the store handles
// the arms assert on.
const mountLookingAtChannel = async (token: string) => {
  seedIdentity(token);
  const auth = await import("../lib/auth");
  const sel = await import("../lib/selection");
  const networks = await import("../lib/networks");
  await import("../lib/userTopic");
  auth.setToken(token);

  await vi.waitFor(() => {
    const nets = networks.networks();
    expect(nets?.length).toBe(1);
    const n = nets?.[0];
    expect(n?.kind).toBe("user");
    if (n?.kind === "user") expect(n.connection_state).toBe("connected");
  });
  // The dispatcher has to be listening, or an arm would fire events into
  // nothing and pass for the wrong reason.
  await vi.waitFor(() => expect(channelMock.handlers.length).toBeGreaterThan(0));

  sel.setSelectedChannel({ networkSlug: NET_SLUG, channelName: CHANNEL, kind: "channel" });
  expect(sel.selectedChannel()?.networkSlug).toBe(NET_SLUG);
  return { sel, networks };
};

describe("issue 2059 — /reconnect bounce keeps the home redirect", () => {
  it("redirects to home when the park is only ever visible in the event", async () => {
    const { sel } = await mountLookingAtChannel("tok2059-race");

    // The bounce: both legs land while any GET they trigger still answers
    // `connected`. This is the measured signature — the store never holds
    // `parked`.
    channelMock.fireEvent(connectionStateChanged("connected", "parked"));
    channelMock.fireEvent(connectionStateChanged("parked", "connected"));

    // The park HAPPENED — the server said so, twice, on the wire. The
    // operator's compose box was torn down under them, so leaving them
    // pointed at the channel is the defect the e2e spec catches as "no
    // .home-pane".
    await vi.waitFor(() => {
      expect(sel.selectedChannel()?.networkSlug).toBe("$home");
    });
  });

  it("does NOT redirect when the parking network is not the selected one", async () => {
    // Negative control for the arm above: without it, a cure that redirects
    // on ANY park event would pass the first arm while breaking every
    // operator watching a second network.
    const { sel } = await mountLookingAtChannel("tok2059-other");

    channelMock.fireEvent({
      ...connectionStateChanged("connected", "parked"),
      network_slug: "freenode",
      network: { ...connectionStateChanged("connected", "parked").network, slug: "freenode" },
    });

    await vi.waitFor(() => expect(channelMock.handlers.length).toBeGreaterThan(0));
    expect(sel.selectedChannel()?.networkSlug).toBe(NET_SLUG);
    expect(sel.selectedChannel()?.channelName).toBe(CHANNEL);
  });

  it("does NOT redirect on a connected → connected event", async () => {
    // The second negative control, and the one that pins the cure's shape:
    // reading the EVENT must not degrade into "any state change redirects".
    // Only a transition INTO parked/failed may move the operator.
    const { sel } = await mountLookingAtChannel("tok2059-noop");

    channelMock.fireEvent(connectionStateChanged("connected", "connected"));

    await vi.waitFor(() => expect(channelMock.handlers.length).toBeGreaterThan(0));
    expect(sel.selectedChannel()?.networkSlug).toBe(NET_SLUG);
    expect(sel.selectedChannel()?.channelName).toBe(CHANNEL);
  });
});
