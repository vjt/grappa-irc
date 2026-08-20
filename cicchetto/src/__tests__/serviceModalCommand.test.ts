import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import type { CommandContext } from "../lib/commands/context";
import { serviceModalCommand } from "../lib/commands/services";
import { appendToScrollback } from "../lib/scrollback";
import { closeServiceModal, serviceMirrorRows, serviceModalState } from "../lib/serviceModal";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #1518 — the `service-modal` arm's statement ORDER, which #290 stated in a
// comment and nothing bought: swapping the two lines left the whole vitest
// suite green (measured on 425426f2), because `compose.test.ts` asserts WHICH
// calls the arm makes and never in what sequence.
//
// The order is load-bearing, and the gap is production's own: `sendBodyLines`
// AWAITS the POST, and the WS handler (`subscribe.ts`, which ingests a NOTICE
// by calling the same `appendToScrollback` this test calls) runs on that event
// loop. A service notice that lands while the POST is in flight is a
// WHILE-OPEN arrival — `openServiceModal` must already have taken the mirror
// high-water mark, so the notice sits ABOVE it and `ServiceModal.tsx` renders
// it (`id > sinceId`). Capture the mark after the await instead and that same
// notice is at or below it: the help wall the modal exists to confine is
// filtered out of the very view that was opened for it.
//
// Only `lib/api`'s `sendMessage` is stubbed, so the await under test is the
// real one — real `sendBodyLines` → real `scrollback.sendMessage` → the POST —
// and the notice is delivered through the real ingest verb. `null` is what a
// `*Serv` target's 202 returns (#1430): the send persists no row of its own.
vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMessage: vi.fn() };
});

const SLUG = "svc-order";
const SERVICE = "NickServ";
const PRE_OPEN_ID = 10;
const IN_FLIGHT_ID = 11;

const notice = (id: number, body: string): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: SERVER_WINDOW_NAME,
  server_time: id,
  kind: "notice",
  sender: SERVICE,
  body,
  meta: {},
});

// The arm reads `ctx.networkSlug` and nothing else off the record (#1396).
// Every other member throws rather than returning a plausible value, so a new
// read shows up as a failure naming the field instead of passing quietly.
const unread = (field: string): (() => never) => {
  return () => {
    throw new Error(`the service-modal arm must not read ctx.${field}`);
  };
};

const context = (): CommandContext => ({
  key: channelKey(SLUG, "#chan"),
  networkSlug: SLUG,
  submittedFrom: "#chan",
  text: "/ns",
  token: "tok",
  getActiveChannel: unread("getActiveChannel"),
  sigils: unread("sigils"),
  requireChannel: unread("requireChannel"),
  requireNetworkId: unread("requireNetworkId"),
  resolveBareWhoisNick: unread("resolveBareWhoisNick"),
});

describe("service-modal arm (#290/#1518)", () => {
  beforeEach(() => {
    // `scrollback.sendMessage` returns early without a bearer, which would
    // skip the POST and with it the mid-send delivery below.
    setToken("tok");
    closeServiceModal();
  });

  it("captures the mirror high-water mark BEFORE `help` goes out, so a notice landing mid-send stays a while-open arrival", async () => {
    const key = channelKey(SLUG, SERVER_WINDOW_NAME);
    appendToScrollback(key, notice(PRE_OPEN_ID, "stale line from a past session"));

    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockImplementation(async () => {
      appendToScrollback(key, notice(IN_FLIGHT_ID, "***** NickServ Help *****"));
      return null;
    });

    await serviceModalCommand({ kind: "service-modal", service: SERVICE }, context());

    // Control — the mid-send notice really did land in the mirror this open
    // reads. Without it the assertion below would hold for a send that never
    // fired at all.
    expect(serviceMirrorRows(SLUG, SERVICE).map((m) => m.id)).toEqual([PRE_OPEN_ID, IN_FLIGHT_ID]);
    // The invariant: the mark is the PRE-send high-water, so the notice that
    // arrived during the send is above it and the modal mirrors it.
    expect(serviceModalState()?.sinceId).toBe(PRE_OPEN_ID);
  });
});
