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
const OTHER_SLUG = "freenode";
const CHANNEL = "#italia";

// `vi.hoisted` because the `vi.mock` factory below is hoisted above every
// plain const, and `beforeEach` re-seeds the same value after resetting the
// queued `once` implementations.
const defaultNetworks = vi.hoisted(() => [
  {
    kind: "user",
    id: 1,
    slug: "azzurra",
    nick: "vjt",
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    kind: "user",
    id: 2,
    slug: "freenode",
    nick: "vjt",
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
]);

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
    //
    // BOTH networks are listed, and the second one is load-bearing rather
    // than scenery: the observer ignores the FIRST state it ever sees for a
    // slug (an operator opening the app on a parked network chose that
    // window). A bench that fired the other-network arm at a slug absent
    // from this list would be stopped by that first-sighting guard and pass
    // without ever reaching the test it means to exercise — measured, on the
    // first cut of this file: the mutation that deletes the slug test left
    // the arm green.
    listNetworks: vi.fn().mockResolvedValue(defaultNetworks),
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
// `failing` is in the closed set too (#1675: [connected, failing, parked,
// failed]) and the arms below need it — it is the one transition that is
// genuinely a CHANGE while not being a park.
type Conn = "connected" | "failing" | "parked" | "failed";
const connectionStateChanged = (from: Conn, to: Conn, slug: string = NET_SLUG) => ({
  kind: "connection_state_changed",
  user_id: "u1",
  network_id: slug === NET_SLUG ? 1 : 2,
  network_slug: slug,
  from,
  to,
  reason: to === "connected" ? null : "rolling a fresh vhost",
  at: "2026-09-10T00:00:00Z",
  network: {
    slug,
    nick: "vjt",
    connection_state: to,
    connection_state_reason: to === "connected" ? null : "rolling a fresh vhost",
    connection_state_changed_at: "2026-09-10T00:00:00Z",
    recoverable: false,
  },
});

// #781 — warm the graph outside the per-test budget. See helpers/warmGraph.ts.
beforeAll(() => warmGraph(() => import("../lib/userTopic")));

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  channelMock.reset();
  channelMock.on.mockClear();
  // `clearAllMocks` wipes call history but NOT queued `once` implementations.
  // Measured: the back-to-back arm below leaves its second
  // `mockResolvedValueOnce` UNCONSUMED (that is the defect it pins), and
  // without this reset the next test received that one-network list and
  // failed on `expect(1).toBe(2)` — a red belonging to the previous arm,
  // landing on an innocent one.
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockReset();
  vi.mocked(api.listNetworks).mockResolvedValue(defaultNetworks);
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

  // Wait for BOTH slugs to be seen once. The observer ignores a slug's first
  // state, so an arm that fired before this settled would be testing the
  // first-sighting guard instead of what it claims to test.
  await vi.waitFor(() => {
    const nets = networks.networks();
    expect(nets?.length).toBe(2);
    for (const n of nets ?? []) {
      expect(n.kind).toBe("user");
      if (n.kind === "user") expect(n.connection_state).toBe("connected");
    }
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

  it("does NOT redirect when a DIFFERENT network parks", async () => {
    // Negative control: a cure that redirects on any park event passes the
    // arm above while bouncing every operator who is watching a second
    // network. `freenode` is in the network list and has been seen
    // `connected` once, so this is a real transition reaching a real
    // observer — not a first sighting being dropped on the floor.
    const { sel } = await mountLookingAtChannel("tok2059-other");

    channelMock.fireEvent(connectionStateChanged("connected", "parked", OTHER_SLUG));

    expect(sel.selectedChannel()?.networkSlug).toBe(NET_SLUG);
    expect(sel.selectedChannel()?.channelName).toBe(CHANNEL);
  });

  // ── the sibling defect, measured rather than inherited ──────────────────
  //
  // issue 2059 names a second failure on this path: two refetches issued in
  // the same microtask collapse into a single GET, the second swallowed,
  // leaving the UI stuck on `parked`. That is a DIFFERENT symptom from the
  // lost redirect — and it reaches the SAME e2e spec, which also asserts the
  // network section loses its greyed class. So a cure for the redirect alone
  // could still leave that spec red. This arm exists to find out whether the
  // collapse is real, stated as an outcome (does the store end on the truth?)
  // rather than as a call count.
  it("ends on the SECOND answer when two refetches are issued back to back", async () => {
    // THREE distinct states on purpose. An earlier cut of this arm ran
    // connected → (parked, connected) and asserted `connected`, which the
    // store already read at mount: `waitFor` returned on its first tick
    // without any GET having answered, and the arm stayed GREEN even when
    // the swallow was fabricated. An assertion that holds BEFORE the action
    // measures nothing.
    //
    // Here the terminal state (`failing`) is one the store has never held,
    // so it can only be reached by the SECOND answer landing. If that
    // refetch is swallowed the row stays `parked` and the arm fails.
    //
    // Driven on the OTHER network so the park does not also trip the home
    // redirect — this arm is about the store, not about selection.
    const api = await import("../lib/api");
    const row = (state: Conn) => ({
      kind: "user" as const,
      id: 2,
      slug: OTHER_SLUG,
      nick: "vjt",
      connection_state: state,
      connection_state_reason: state === "connected" ? null : "rolling a fresh vhost",
      connection_state_changed_at: null,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const { networks } = await mountLookingAtChannel("tok2059-collapse");

    vi.mocked(api.listNetworks).mockResolvedValueOnce([row("parked")]);
    vi.mocked(api.listNetworks).mockResolvedValueOnce([row("failing")]);
    const netModule = await import("../lib/networks");
    netModule.refetchNetworks();
    netModule.refetchNetworks();

    await vi.waitFor(() => {
      const n = networks.networks()?.find((x) => x.slug === OTHER_SLUG);
      expect(n?.kind).toBe("user");
      if (n?.kind === "user") expect(n.connection_state).toBe("failing");
    });
  });

  it("does NOT redirect on a connected → failing transition of the selected network", async () => {
    // The second negative control, and the one that pins the cure's shape:
    // reading the EVENT must not degrade into "any state change redirects".
    // `failing` (#1675) is the discriminating case — a genuine transition of
    // the SELECTED network that is nonetheless not a park, so nothing but
    // the parked/failed test can stop it. `connected` → `connected` would
    // not do: the same-value test stops that one first, and the arm would
    // pass whether or not the cure kept the park gate at all.
    const { sel } = await mountLookingAtChannel("tok2059-failing");

    channelMock.fireEvent(connectionStateChanged("connected", "failing"));

    expect(sel.selectedChannel()?.networkSlug).toBe(NET_SLUG);
    expect(sel.selectedChannel()?.channelName).toBe(CHANNEL);
  });
});
