import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Network } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import type { CommandContext } from "../lib/commands/context";
import { joinCommand } from "../lib/commands/window";

// issue 2719 — `/join` is one of the doors into `channelJoin.joinChannel`, the
// one join verb. ComposeBox greys the box of a network with no session but does
// not disable it, so `/join` can be typed there, and a door that skipped the
// reconnect would be the drift the verb exists to stop.
// The REAL verb runs here; only the REST calls, the bearer, the networks
// store and the focus setter are mocked, at their boundaries.

const wire: string[] = [];
const networkBySlugMock = vi.fn<(slug: string) => Network | undefined>();
const setSelectedChannelMock = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postJoin: (_t: string, slug: string, name: string, key: string | null) => {
      wire.push(`POST ${slug} ${name} ${key}`);
      return Promise.resolve();
    },
    patchNetwork: (_t: string, slug: string, body: { connection_state: string }) => {
      wire.push(`PATCH ${slug} ${body.connection_state}`);
      return Promise.resolve({});
    },
  };
});

vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
  token: () => "tok",
}));

vi.mock("../lib/networks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/networks")>()),
  networkBySlug: (slug: string) => networkBySlugMock(slug),
}));

vi.mock("../lib/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/selection")>()),
  setSelectedChannel: (...args: unknown[]) => setSelectedChannelMock(...args),
}));

const SLUG = "azzurra";

const netIn = (connection_state: string): Network =>
  ({ kind: "user", id: 1, slug: SLUG, nick: "vjt", connection_state }) as unknown as Network;

// Only `token` and `networkSlug` are read by `/join`; the rest is the shape.
const ctx = {
  key: channelKey(SLUG, "#a"),
  networkSlug: SLUG,
  submittedFrom: "#a",
  text: "/join",
  token: "tok",
} as unknown as CommandContext;

beforeEach(() => {
  wire.length = 0;
  vi.clearAllMocks();
});

describe("/join through the one join verb (issue 2719)", () => {
  it("reconnects a parked network before it joins", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));

    const outcome = await joinCommand({ kind: "join", channels: ["#Sniffo"], key: null }, ctx);

    expect(wire).toEqual([`PATCH ${SLUG} connected`, `POST ${SLUG} #Sniffo null`]);
    expect(outcome).toEqual({ ok: true });
  });

  it("sends the comma-list and key unchanged on a connected network, focusing the first", async () => {
    networkBySlugMock.mockReturnValue(netIn("connected"));

    await joinCommand({ kind: "join", channels: ["#Foo[1]", "#bar"], key: "k" }, ctx);

    expect(wire).toEqual([`POST ${SLUG} #Foo[1],#bar k`]);
    expect(setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: SLUG,
      channelName: "#foo[1]",
      kind: "channel",
    });
  });
});
