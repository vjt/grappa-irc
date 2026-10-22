import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import {
  catchUpPairings,
  deliverPairingEvent,
  joinPairing,
  openChannel,
  openPairing,
  pairingUrl,
  parsePairFragment,
  type Rendezvous,
} from "../lib/e2e/pairing";
import { WireShapeError } from "../lib/wireNarrow";

// issue 2430, X1 — the client half of the pairing relay. grappa is faked at
// `fetch`, so the requests asserted are the bytes that would leave.

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

type Call = { url: string; method: string; auth: string | null; body: unknown };

let calls: Call[];
let answer: (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  answer = () => json(500, { error: "unexpected" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = {
        url,
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return answer(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pairing code", () => {
  it("rides the fragment of the /pair route", () => {
    expect(pairingUrl("https://grappa.example", { id: ID, curve: CURVE })).toBe(
      `https://grappa.example/pair#pair=${ID}.${CURVE}`,
    );
  });

  it("parses back from the fragment, with or without its #", () => {
    expect(parsePairFragment(`#pair=${ID}.${CURVE}`)).toEqual({ id: ID, curve: CURVE });
    expect(parsePairFragment(`pair=${ID}.${CURVE}`)).toEqual({ id: ID, curve: CURVE });
  });

  it.each([
    ["", "nothing"],
    [`#share=${ID}.${CURVE}`, "another key"],
    [`#pair=${ID}`, "no curve"],
    [`#pair=${ID}.${CURVE}.x`, "a third part"],
    [`#pair=${ID.slice(1)}.${CURVE}`, "a short id"],
    [`#pair=${ID.slice(1)}+.${CURVE}`, "an id outside url-safe base64"],
    [`#pair=${ID}.${CURVE}=`, "a padded curve"],
    [`#pair=${ID}.${CURVE.slice(1)}-`, "a curve outside standard base64"],
  ])("refuses %s (%s)", (hash) => {
    expect(parsePairFragment(hash)).toBeNull();
  });

  it("will not build a URL from a malformed code", () => {
    expect(() => pairingUrl("https://h", { id: "short", curve: CURVE })).toThrow();
    expect(() => pairingUrl("https://h", { id: ID, curve: "short" })).toThrow();
  });
});

describe("the REST doors", () => {
  const rendezvous: Rendezvous = { id: ID, role: "creator", expires_at: "2026-10-22T18:00:00Z" };

  it("opens with the bearer and reads the rendezvous", async () => {
    answer = () => json(201, { rendezvous });
    await expect(openPairing("tok")).resolves.toEqual(rendezvous);
    expect(calls).toEqual([
      { url: "/e2e/pairings", method: "POST", auth: "Bearer tok", body: undefined },
    ]);
  });

  it("joins by id", async () => {
    answer = () => json(200, { rendezvous: { ...rendezvous, role: "joiner" } });
    await expect(joinPairing("tok", ID)).resolves.toMatchObject({ role: "joiner" });
    expect(calls[0]).toMatchObject({ url: `/e2e/pairings/${ID}/join`, method: "POST" });
  });

  it("surfaces a used code as its own error", async () => {
    answer = () => json(409, { error: "pairing_already_joined" });
    const err = await joinPairing("tok", ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("pairing_already_joined");
  });

  it("refuses an answer of the wrong shape", async () => {
    answer = () => json(201, { rendezvous: { id: ID } });
    await expect(openPairing("tok")).rejects.toBeInstanceOf(WireShapeError);
  });
});

describe("the channel", () => {
  const creator: Rendezvous = { id: ID, role: "creator", expires_at: "2026-10-22T18:00:00Z" };

  const settle = () => new Promise((r) => setTimeout(r, 0));

  // A channel catches up once as it opens; with nothing posted yet that
  // fetch is empty, and each test starts counting after it.
  const setup = async () => {
    const got: string[] = [];
    const closed: string[] = [];
    answer = () => json(200, { messages: [] });
    const ch = openChannel("tok", creator, {
      onMessage: (p) => got.push(p),
      onClosed: (r) => closed.push(r),
    });
    await settle();
    calls = [];
    return { ch, got, closed };
  };

  const ring = (seq: number, from: "creator" | "joiner") =>
    deliverPairingEvent({ kind: "e2e_pairing_message", rendezvous_id: ID, seq, from });

  // Every test leaves no channel behind: grappa says 204 to the close.
  const done = async (ch: { close: () => Promise<void> }) => {
    answer = () => new Response(null, { status: 204 });
    await ch.close();
  };

  it("fetches on the other side's push and delivers in order", async () => {
    const { ch, got } = await setup();
    answer = (c) =>
      c.url.endsWith("after=0")
        ? json(200, {
            messages: [
              { seq: 1, from: "joiner", payload: "b25l" },
              { seq: 3, from: "joiner", payload: "dGhyZWU" },
            ],
          })
        : json(200, { messages: [] });
    ring(3, "joiner");
    await settle();
    expect(got).toEqual(["b25l", "dGhyZWU"]);
    expect(calls.map((c) => c.url)).toEqual([`/e2e/pairings/${ID}/messages?after=0`]);
    await done(ch);
  });

  it("asks only for what follows the last seq it delivered", async () => {
    const { ch, got } = await setup();
    answer = (c) =>
      c.url.endsWith("after=0")
        ? json(200, { messages: [{ seq: 1, from: "joiner", payload: "b25l" }] })
        : json(200, { messages: [{ seq: 4, from: "joiner", payload: "Zm91cg" }] });
    ring(1, "joiner");
    await settle();
    ring(4, "joiner");
    await settle();
    expect(got).toEqual(["b25l", "Zm91cg"]);
    expect(calls.map((c) => c.url)).toEqual([
      `/e2e/pairings/${ID}/messages?after=0`,
      `/e2e/pairings/${ID}/messages?after=1`,
    ]);
    await done(ch);
  });

  it("never delivers one message twice, however the pushes overlap", async () => {
    const { ch, got } = await setup();
    answer = () => json(200, { messages: [{ seq: 1, from: "joiner", payload: "b25l" }] });
    ring(1, "joiner");
    ring(1, "joiner");
    await ch.catchUp();
    expect(got).toEqual(["b25l"]);
    await done(ch);
  });

  it("ignores its own side's push and another rendezvous's", async () => {
    const { ch } = await setup();
    ring(2, "creator");
    deliverPairingEvent({
      kind: "e2e_pairing_message",
      rendezvous_id: "x".repeat(22),
      seq: 1,
      from: "joiner",
    });
    await settle();
    expect(calls).toEqual([]);
    await done(ch);
  });

  it("keeps fetching after a failed fetch", async () => {
    const { ch, got } = await setup();
    answer = () => json(503, { error: "unavailable" });
    await expect(ch.catchUp()).rejects.toBeInstanceOf(ApiError);
    answer = () => json(200, { messages: [{ seq: 1, from: "joiner", payload: "b25l" }] });
    await ch.catchUp();
    expect(got).toEqual(["b25l"]);
    await done(ch);
  });

  it("sends a payload to the rendezvous", async () => {
    const { ch } = await setup();
    answer = () => json(201, { message: { seq: 2, from: "creator", payload: "aGk" } });
    await ch.send("aGk");
    expect(calls[0]).toEqual({
      url: `/e2e/pairings/${ID}/messages`,
      method: "POST",
      auth: "Bearer tok",
      body: { payload: "aGk" },
    });
    await done(ch);
  });

  it("ends on the closed push, and hears nothing after", async () => {
    const { closed } = await setup();
    deliverPairingEvent({ kind: "e2e_pairing_closed", rendezvous_id: ID, reason: "expired" });
    ring(5, "joiner");
    await settle();
    expect(closed).toEqual(["expired"]);
    expect(calls).toEqual([]);
  });

  it("delivers, as it opens, what the other side posted before it was registered", async () => {
    answer = () => json(200, { messages: [{ seq: 1, from: "joiner", payload: "b25l" }] });
    const got: string[] = [];
    const ch = openChannel("tok", creator, {
      onMessage: (p) => got.push(p),
      onClosed: () => undefined,
    });
    await settle();
    expect(got).toEqual(["b25l"]);
    expect(calls.map((c) => c.url)).toEqual([`/e2e/pairings/${ID}/messages?after=0`]);
    await done(ch);
  });

  it("catches every live channel up on a user-topic (re)join, the push being lost", async () => {
    const { ch, got } = await setup();
    answer = () => json(200, { messages: [{ seq: 1, from: "joiner", payload: "b25l" }] });
    catchUpPairings();
    await settle();
    expect(got).toEqual(["b25l"]);
    await done(ch);
  });

  it("ends once, by the push, when a fetch in flight then finds the rendezvous gone", async () => {
    const { closed } = await setup();
    let release: (r: Response) => void = () => undefined;
    answer = () => new Promise<Response>((r) => (release = r));
    ring(1, "joiner");
    deliverPairingEvent({ kind: "e2e_pairing_closed", rendezvous_id: ID, reason: "expired" });
    release(json(404, { error: "not_found" }));
    await settle();
    expect(closed).toEqual(["expired"]);
  });

  it("fetches nothing once it has ended", async () => {
    const { ch } = await setup();
    answer = () => new Response(null, { status: 204 });
    await ch.close();
    calls = [];
    await ch.catchUp();
    expect(calls).toEqual([]);
  });

  it("takes a close the rendezvous already outlived as done, not as a failure", async () => {
    const { ch } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answer = () => json(404, { error: "not_found" });
    await ch.close();
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ends as gone when a fetch finds the rendezvous no longer there", async () => {
    const { ch, closed } = await setup();
    answer = () => json(404, { error: "not_found" });
    await ch.catchUp();
    expect(closed).toEqual(["gone"]);
    calls = [];
    ring(2, "joiner");
    catchUpPairings();
    await settle();
    expect(calls).toEqual([]);
  });

  it("logs a failed close rather than throwing it, and stays closed", async () => {
    const { ch, closed } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answer = () => json(500, { error: "unexpected" });
    await expect(ch.close()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[pairing] close failed on ${ID}`, expect.any(ApiError));
    expect(closed).toEqual([]);
    warn.mockRestore();
  });

  it("closes for both sides, once, without telling its own caller", async () => {
    const { ch, closed } = await setup();
    answer = () => new Response(null, { status: 204 });
    await ch.close();
    await ch.close();
    deliverPairingEvent({ kind: "e2e_pairing_closed", rendezvous_id: ID, reason: "closed" });
    expect(closed).toEqual([]);
    expect(calls).toEqual([
      { url: `/e2e/pairings/${ID}`, method: "DELETE", auth: "Bearer tok", body: undefined },
    ]);
  });
});
