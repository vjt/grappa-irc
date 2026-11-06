import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRow } from "../lib/e2e/chatStore";
import type {
  SessionWireE2eIncomingLostPayload,
  SessionWireE2eIncomingPayload,
  SessionWireE2eMessagePayload,
} from "../lib/wireTypes";

// issue 2577 — an encrypted message on its way, as grappa announces it. The
// encrypted chats (this device's id, the chat's rows, the inbox drain) are the
// boundary: a reactive stand-in here. The store is a page singleton, so every
// test gets a network of its own.

const [dids, setDids] = createSignal<Record<string, string>>({});
const [rows, setRows] = createSignal<Record<string, ChatRow[]>>({});
const drainE2e = vi.hoisted(() => vi.fn());
vi.mock("../lib/encryptedChats", () => ({
  ownDevice: (slug: string) => dids()[slug],
  encryptedRows: (slug: string, nick: string) => rows()[`${slug} ${nick.toLowerCase()}`],
  drainE2e,
}));
const [bearer, setBearer] = createSignal<string | null>("tok");
vi.mock("../lib/auth", () => ({ token: () => bearer() }));

const store = await import("../lib/encryptedArriving");

const OWN = "OwnDeviceId";
const PEER = "AaZaARRDyBk";

let slug: string;
let netCount = 0;

const incoming = (over: Partial<SessionWireE2eIncomingPayload>): SessionWireE2eIncomingPayload => ({
  kind: "e2e_incoming",
  network: slug,
  from: "Alice",
  from_did: PEER,
  to: "*",
  msgid: "q83vEjRWeJA",
  ...over,
});

const lost = (
  over: Partial<SessionWireE2eIncomingLostPayload>,
): SessionWireE2eIncomingLostPayload => ({
  kind: "e2e_incoming_lost",
  network: slug,
  from_did: PEER,
  to: "*",
  msgid: "q83vEjRWeJA",
  ...over,
});

const queued = (over: Partial<SessionWireE2eMessagePayload>): SessionWireE2eMessagePayload => ({
  kind: "e2e_message",
  id: 7,
  network: slug,
  from: "Alice",
  from_did: PEER,
  to_did: OWN,
  verb: "msg",
  msgid: "q83vEjRWeJA",
  payload: "e30",
  own: false,
  ...over,
});

const msgids = (nick: string) => store.encryptedArriving(slug, nick).map((a) => a.msgid);

beforeEach(() => {
  vi.resetAllMocks();
  netCount += 1;
  slug = `net${netCount}`;
  setDids((prev) => ({ ...prev, [slug]: OWN }));
  drainE2e.mockResolvedValue(undefined);
});

describe("e2e_incoming", () => {
  it("shows a message to this device or to every device in the sender's chat, in arrival order", () => {
    store.e2eIncoming(incoming({ msgid: "AAAAAAAAAAA", to: "*" }));
    store.e2eIncoming(incoming({ msgid: "BBBBBBBBBBB", to: OWN }));

    expect(store.encryptedArriving(slug, "alice")).toEqual([
      expect.objectContaining({ nick: "Alice", msgid: "AAAAAAAAAAA" }),
      expect.objectContaining({ nick: "Alice", msgid: "BBBBBBBBBBB" }),
    ]);
    expect(msgids("bob")).toEqual([]);
  });

  it("ignores a message to another device of the user", () => {
    store.e2eIncoming(incoming({ to: "AnotherDevc" }));

    expect(msgids("Alice")).toEqual([]);
  });

  it("ignores everything while this device's id on the network is not known", () => {
    setDids((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    store.e2eIncoming(incoming({ to: "*" }));

    expect(msgids("Alice")).toEqual([]);
  });

  it("shows a repeated announcement once", () => {
    store.e2eIncoming(incoming({}));
    store.e2eIncoming(incoming({}));

    expect(msgids("Alice")).toEqual(["q83vEjRWeJA"]);
  });
});

describe("what ends it", () => {
  it("the message landing in the chat: a row carrying its msgid takes its place", () => {
    store.e2eIncoming(incoming({ msgid: "AAAAAAAAAAA" }));
    store.e2eIncoming(incoming({ msgid: "BBBBBBBBBBB" }));
    setRows((prev) => ({
      ...prev,
      [`${slug} alice`]: [
        {
          kind: "in",
          id: "in:7:0",
          at: 1,
          nick: "Alice",
          ed25519: "M",
          body: "ciao",
          wire: [{ verb: "msg", msgid: "AAAAAAAAAAA", payload: "e30" }],
        },
      ],
    }));

    expect(msgids("Alice")).toEqual(["BBBBBBBBBBB"]);
  });

  it("grappa saying it will not reach this device, or any", () => {
    store.e2eIncoming(incoming({ msgid: "AAAAAAAAAAA" }));
    store.e2eIncoming(incoming({ msgid: "BBBBBBBBBBB" }));
    store.e2eIncoming(incoming({ msgid: "CCCCCCCCCCC" }));

    store.e2eIncomingLost(lost({ msgid: "AAAAAAAAAAA", to: OWN }));
    store.e2eIncomingLost(lost({ msgid: "BBBBBBBBBBB", to: "*" }));
    store.e2eIncomingLost(lost({ msgid: "CCCCCCCCCCC", to: "AnotherDevc" }));

    expect(msgids("Alice")).toEqual(["CCCCCCCCCCC"]);
  });

  it("a loss names the message by its sending device and msgid, not by msgid alone", () => {
    store.e2eIncoming(incoming({}));

    store.e2eIncomingLost(lost({ from_did: "SomeoneElse" }));

    expect(msgids("Alice")).toEqual(["q83vEjRWeJA"]);
  });

  it("grappa queuing it for this device: once the drain that brings it has run", async () => {
    let finish: () => void = () => {};
    drainE2e.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    store.e2eIncoming(incoming({}));

    const settled = store.e2eMessageQueued(queued({}));
    expect(drainE2e).toHaveBeenCalledWith(slug);
    // Still there while the drain runs: the row has not landed yet.
    expect(msgids("Alice")).toEqual(["q83vEjRWeJA"]);

    finish();
    await settled;
    expect(msgids("Alice")).toEqual([]);
  });

  it("a drain that fails ends it too: the message waits in the inbox for the next one", async () => {
    drainE2e.mockRejectedValue(new Error("offline"));
    store.e2eIncoming(incoming({}));

    await expect(store.e2eMessageQueued(queued({}))).rejects.toThrow("offline");
    expect(msgids("Alice")).toEqual([]);
  });

  it("grappa queuing it for another device drains, and ends nothing here", async () => {
    store.e2eIncoming(incoming({}));

    await store.e2eMessageQueued(queued({ to_did: "AnotherDevc" }));

    expect(drainE2e).toHaveBeenCalledWith(slug);
    expect(msgids("Alice")).toEqual(["q83vEjRWeJA"]);
  });

  it("a change of identity", () => {
    store.e2eIncoming(incoming({}));

    setBearer("another-login");

    expect(msgids("Alice")).toEqual([]);
    setBearer("tok");
  });
});
