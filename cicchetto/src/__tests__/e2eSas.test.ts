// issue 2430 — SAS between two people in cic (slice d): the vodozemac
// binding's SAS, then the protocol between two real cics on the fake grappa
// (`helpers/e2eClients.ts`). Every step goes through Olm and grappa's doors
// as the real thing does; a peer that misbehaves is played by sending its
// inner message by hand on its real session (`inject`).
import { describe, expect, it, vi } from "vitest";
import { SAS_TIMEOUT_MS, type SasRecord, type SasStep } from "../lib/e2e/sas";
import { base64Unpadded, fold } from "../lib/e2e/wire";
import { chat, inject, pair, rowsOf, type Side, SLOT } from "./helpers/e2eClients";
import { olm } from "./helpers/olm";

const keyOf = (side: Side) =>
  side.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());

const view = async (side: Side, nick: string) =>
  (await side.client.identity(side.ctx, [nick])).sas[fold(nick)] ?? null;

const verified = async (side: Side, nick: string) =>
  (await side.client.identity(side.ctx, [nick])).peers[fold(nick)]?.verified;

const step = (side: Side, nick: string, s: SasStep) => side.client.verify(side.ctx, nick, s);

/** The SAS rows of a chat, as [kind, by, reason]. */
const sasRows = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).flatMap((r) => {
    switch (r.kind) {
      case "sas_asked":
        return [[r.kind, r.by]];
      case "sas_cancelled":
        return [[r.kind, r.by, r.reason]];
      case "verified":
        return [[r.kind]];
      default:
        return [];
    }
  });

const recordOf = (side: Side, peer: string): Promise<SasRecord | undefined> =>
  side.accounts.withAccount(SLOT, async ({ state }) => state.sas[peer]);

/** alice asks, Bob accepts, and the keys go both ways: both compare. */
async function toCompare(a: Side, b: Side): Promise<void> {
  await step(a, "bob", "start");
  await b.client.drain(b.ctx);
  await step(b, "alice", "accept");
  await a.client.drain(a.ctx);
  await b.client.drain(b.ctx);
  await a.client.drain(a.ctx);
}

describe("the binding's SAS", () => {
  it("gives both ends the same 7 emoji and the same MACs, from each other's public half", () => {
    const { Sas } = olm();
    const alice = new Sas();
    const bob = new Sas();
    const aliceKey = alice.public_key();
    const bobKey = bob.public_key();

    const a = alice.diffie_hellman(bobKey);
    const b = bob.diffie_hellman(aliceKey);

    const emoji = [...a.emoji_indices("info")];
    expect(emoji).toHaveLength(7);
    expect(emoji.every((i) => i >= 0 && i < 64)).toBe(true);
    expect([...b.emoji_indices("info")]).toEqual(emoji);
    expect([...b.emoji_indices("other info")]).not.toEqual(emoji);
    expect(b.calculate_mac("input", "info")).toBe(a.calculate_mac("input", "info"));
    expect(b.calculate_mac("input", "info")).toMatch(/^[A-Za-z0-9+/]{43}$/);
    a.free();
    b.free();
  });

  it("refuses what is not a Curve25519 key, and a SAS is used up by its exchange", () => {
    const { Sas } = olm();
    expect(() => new Sas().diffie_hellman("not a key")).toThrow();
    const sas = new Sas();
    sas.diffie_hellman(new Sas().public_key()).free();
    expect(() => sas.diffie_hellman(new Sas().public_key())).toThrow();
  });
});

describe("SAS between two people", () => {
  it("both see the same 7 emoji; a match on both sides verifies each key on the other", async () => {
    const { a, b } = await pair();
    await chat(a, b);

    const started = await step(a, "bob", "start");
    expect(started.waiting).toBe(true);
    expect(await view(a, "bob")).toEqual({
      role: "a",
      phase: "started",
      confirmed: false,
      here: true,
      emoji: null,
    });

    await b.client.drain(b.ctx);
    expect(await view(b, "alice")).toEqual({
      role: "b",
      phase: "asked",
      confirmed: false,
      here: false,
      emoji: null,
    });
    expect((await b.chats.chats(SLOT)).alice?.unread).toBe(2);

    await step(b, "alice", "accept");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    await a.client.drain(a.ctx);

    const seenByAlice = await view(a, "bob");
    const seenByBob = await view(b, "alice");
    expect(seenByAlice).toEqual(expect.objectContaining({ phase: "compare", here: true }));
    expect(seenByAlice?.emoji).toHaveLength(7);
    expect(seenByBob?.emoji).toEqual(seenByAlice?.emoji);

    await step(a, "bob", "match");
    await b.client.drain(b.ctx);
    // alice's MAC is in, but Bob's own human has not confirmed yet.
    expect(await verified(b, "alice")).toBe(false);
    expect(await view(b, "alice")).toEqual(
      expect.objectContaining({ phase: "compare", confirmed: false }),
    );
    expect(await view(a, "bob")).toEqual(
      expect.objectContaining({ phase: "compare", confirmed: true, emoji: null }),
    );

    await step(b, "alice", "match");
    expect(await verified(b, "alice")).toBe(true);
    await a.client.drain(a.ctx);
    expect(await verified(a, "bob")).toBe(true);

    expect(await view(a, "bob")).toBeNull();
    expect(await view(b, "alice")).toBeNull();
    expect(await sasRows(a, "bob")).toEqual([["sas_asked", "you"], ["verified"]]);
    expect(await sasRows(b, "alice")).toEqual([["sas_asked", "peer"], ["verified"]]);
    expect(await rowsOf(a, "bob")).toContainEqual(
      expect.objectContaining({ kind: "verified", nick: "bob", ed25519: await keyOf(b) }),
    );
  });

  it("a mismatch on either side cancels it on both, and verifies nobody", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await toCompare(a, b);

    await step(b, "alice", "mismatch");
    await a.client.drain(a.ctx);

    expect(await view(a, "bob")).toBeNull();
    expect(await view(b, "alice")).toBeNull();
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "peer", "mismatch"],
    ]);
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "mismatch"],
    ]);
    expect(await verified(a, "bob")).toBe(false);
    expect(await verified(b, "alice")).toBe(false);
  });

  it("declining the request cancels it on the side that asked", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);

    await step(b, "alice", "cancel");
    await a.client.drain(a.ctx);

    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "peer", "user"],
    ]);
    expect(await view(a, "bob")).toBeNull();
  });

  it("a peer MAC that is not the one expected cancels it: mac-mismatch", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await toCompare(a, b);
    const { tx } = (await recordOf(a, await keyOf(b))) as SasRecord;

    await inject(w, b, "alice", { t: "sas.mac", tx, mac: "A".repeat(43) });
    await a.client.drain(a.ctx);
    expect(await verified(a, "bob")).toBe(false);
    await step(a, "bob", "match");
    await b.client.drain(b.ctx);

    expect(await verified(a, "bob")).toBe(false);
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "mac-mismatch"],
    ]);
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "mac-mismatch"],
    ]);
  });

  it("a key that is not the one committed to cancels it: commitment-mismatch", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    await a.client.drain(a.ctx);
    const { tx } = (await recordOf(a, await keyOf(b))) as SasRecord;

    await inject(w, b, "alice", { t: "sas.key", tx, key: new (olm().Sas)().public_key() });
    await a.client.drain(a.ctx);

    expect(await view(a, "bob")).toBeNull();
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "commitment-mismatch"],
    ]);
  });

  it("a step out of order cancels it: unexpected-message", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    const { tx } = (await recordOf(a, await keyOf(b))) as SasRecord;

    await inject(w, b, "alice", { t: "sas.mac", tx, mac: "A".repeat(43) });
    await a.client.drain(a.ctx);

    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
  });

  it("a second MAC for the same SAS is out of order: unexpected-message", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await toCompare(a, b);
    await step(a, "bob", "match");
    await b.client.drain(b.ctx);
    const tx = (await recordOf(b, await keyOf(a)))?.tx;

    await inject(w, a, "Bob", { t: "sas.mac", tx, mac: "A".repeat(43) });
    await b.client.drain(b.ctx);

    expect(await view(b, "alice")).toBeNull();
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
    expect(await verified(b, "alice")).toBe(false);
  });

  it("a new start from the peer replaces the SAS that ran with its key, and its secret", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    expect(b.host.secrets.size).toBe(1);

    await inject(w, a, "Bob", { t: "sas.start", tx: "BBBBBBBBBBB" });
    await b.client.drain(b.ctx);

    expect(await recordOf(b, await keyOf(a))).toEqual(
      expect.objectContaining({ tx: "BBBBBBBBBBB", phase: "asked", page: null, ourKey: null }),
    );
    expect(b.host.secrets.size).toBe(0);
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_asked", "peer"],
    ]);
  });

  it("a request not yet accepted is no page's: no page going away cancels it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);

    w.close(b);
    await b.client.tick(b.ctx);

    expect(await view(b, "alice")).toEqual(expect.objectContaining({ phase: "asked" }));
  });

  it("ignores a step from a key that is not the SAS's", async () => {
    const { w, a, b } = await pair();
    const carol = await w.join("carol");
    await chat(a, b);
    await chat(a, carol);
    await step(a, "bob", "start");
    const before = await recordOf(a, await keyOf(b));

    await inject(w, carol, "alice", {
      t: "sas.accept",
      tx: before?.tx,
      commitment: "A".repeat(43),
    });
    await a.client.drain(a.ctx);

    expect(await recordOf(a, await keyOf(b))).toEqual(before);
    expect(await sasRows(a, "carol")).toEqual([]);
  });

  it("ignores a step for another tx, and a step that does not parse", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    const before = (await recordOf(a, await keyOf(b))) as SasRecord;
    const other = before.tx.startsWith("A") ? `B${before.tx.slice(1)}` : `A${before.tx.slice(1)}`;

    await inject(w, b, "alice", { t: "sas.accept", tx: other, commitment: "A".repeat(43) });
    await inject(w, b, "alice", { t: "sas.accept", tx: before.tx, commitment: "short" });
    await inject(w, b, "alice", { t: "sas.accept", tx: "short", commitment: "A".repeat(43) });
    await a.client.drain(a.ctx);

    expect(await recordOf(a, await keyOf(b))).toEqual(before);
    expect(await sasRows(a, "bob")).toEqual([["sas_asked", "you"]]);
  });

  it("commits to B's key as w2's encoding says: sha256 of key|tx, unpadded base64", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    await a.client.drain(a.ctx);

    const theirs = (await recordOf(b, await keyOf(a))) as SasRecord;
    const ours = (await recordOf(a, await keyOf(b))) as SasRecord;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${theirs.ourKey}|${theirs.tx}`),
    );
    expect(ours.commitment).toBe(base64Unpadded(new Uint8Array(digest)));
  });

  it("an accept from a second tab, once the first accepted, changes nothing", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    const accepted = await recordOf(b, await keyOf(a));
    const sends = w.grappa.sends.length;

    await step(w.tab(b), "alice", "accept");

    expect(await recordOf(b, await keyOf(a))).toEqual(accepted);
    expect(w.grappa.sends).toHaveLength(sends);
  });

  it("ignores a start from a key the nick is not pinned to", async () => {
    const { w, a, b } = await pair();
    const c = await w.join("carol");
    await chat(a, b);
    await chat(a, c);
    // Bob's key, writing from carol's nick: read as Bob, but "carol" is
    // pinned to Carol's key, and Bob's window is not where this came from.
    const asCarol = {
      ...b,
      nick: "carol",
      ctx: { ...b.ctx, ownNick: "carol", door: w.grappa.door("carol") },
    };

    await inject(w, asCarol, "alice", { t: "sas.start", tx: "AAAAAAAAAAA" });
    await a.client.drain(a.ctx);

    expect(await recordOf(a, await keyOf(b))).toBeUndefined();
    expect(await view(a, "bob")).toBeNull();
    expect(await view(a, "carol")).toBeNull();
    expect(await sasRows(a, "carol")).toEqual([]);
  });

  it("ignores a start whose tx does not parse", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);

    await inject(w, b, "alice", { t: "sas.start", tx: "short" });
    await a.client.drain(a.ctx);

    expect(await view(a, "bob")).toBeNull();
    expect(await sasRows(a, "bob")).toEqual([]);
  });

  it("a start repeated changes nothing", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(b, "alice", "start");
    await a.client.drain(a.ctx);
    const asked = (await recordOf(a, await keyOf(b))) as SasRecord;

    await inject(w, b, "alice", { t: "sas.start", tx: asked.tx });
    await a.client.drain(a.ctx);

    expect(await recordOf(a, await keyOf(b))).toEqual(asked);
    expect(await sasRows(a, "bob")).toEqual([["sas_asked", "peer"]]);
  });

  it("an accept once the keys are on their way is out of order", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    await a.client.drain(a.ctx);
    const { tx } = (await recordOf(a, await keyOf(b))) as SasRecord;

    await inject(w, b, "alice", { t: "sas.accept", tx, commitment: "A".repeat(43) });
    await a.client.drain(a.ctx);

    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
  });

  it("a SAS key that makes no secret ends it: bad-key", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(b, "alice", "start");
    await a.client.drain(a.ctx);
    await step(a, "bob", "accept");
    const { tx } = (await recordOf(a, await keyOf(b))) as SasRecord;

    // 32 zero bytes: a point every exchange with gives the same, zero, secret.
    await inject(w, b, "alice", { t: "sas.key", tx, key: "A".repeat(43) });
    await a.client.drain(a.ctx);

    expect(await view(a, "bob")).toBeNull();
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "bad-key"],
    ]);
    await b.client.drain(b.ctx);
    expect(await sasRows(b, "alice")).toContainEqual(["sas_cancelled", "peer", "bad-key"]);
  });

  it("a peer whose curve another key took ends the SAS, and the window still reads: bad-key", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await toCompare(a, b);
    // What the engine does when another key proves the curve this one claimed.
    const bobKey = await keyOf(b);
    await a.accounts.withAccount(SLOT, async ({ state }) => {
      const peer = state.peers[bobKey];
      if (peer !== undefined) state.peers[bobKey] = { ...peer, curve25519: null };
    });

    expect(await view(a, "bob")).toBeNull();

    // The cancel waits for keys (the curve it would go to is gone); Bob's
    // side runs into its timeout.
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "bad-key"],
    ]);
    expect(await view(a, "bob")).toBeNull();
  });

  it("derives the emoji and the MACs from the bytes w2's proposal names", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await toCompare(a, b);
    const [aEd, bEd] = [await keyOf(a), await keyOf(b)];
    const curveOf = (side: Side) =>
      side.accounts.withAccount(SLOT, async ({ account }) => account.curve25519_key());
    const [aCurve, bCurve] = [await curveOf(a), await curveOf(b)];
    const ours = (await recordOf(a, bEd)) as SasRecord;
    const theirs = (await recordOf(b, aEd)) as SasRecord;
    const emoji = (await view(a, "bob"))?.emoji;
    const secret = a.host.secrets.get(ours.ourKey ?? "");
    if (!(secret instanceof olm().EstablishedSas)) throw new Error("no secret on alice's page");

    // A (alice) first: her identity curve and SAS key, then Bob's, then the tx.
    const info = `irc-e2e:v1:sas:${aCurve}|${ours.ourKey}|${bCurve}|${theirs.ourKey}|${ours.tx}`;
    expect([...secret.emoji_indices(info)]).toEqual(emoji);
    const bobsMac = secret.calculate_mac(bEd, `irc-e2e:v1:sas-mac:${bCurve}|${aCurve}|${ours.tx}`);
    await step(a, "bob", "match");
    expect((await recordOf(a, bEd))?.expected).toBe(bobsMac);
  });

  it("both asking at once: the smaller tx wins on both sides, and the comparison goes on", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    const [aliceKey, bobKey] = [await keyOf(a), await keyOf(b)];

    await step(a, "bob", "start");
    await step(b, "alice", "start");
    const aliceTx = (await recordOf(a, bobKey))?.tx as string;
    const bobTx = (await recordOf(b, aliceKey))?.tx as string;
    for (let i = 0; i < 3; i++) {
      await a.client.drain(a.ctx);
      await b.client.drain(b.ctx);
    }

    const smaller = aliceTx < bobTx ? aliceTx : bobTx;
    expect((await recordOf(a, bobKey))?.tx).toBe(smaller);
    expect((await recordOf(b, aliceKey))?.tx).toBe(smaller);
    const seenByAlice = await view(a, "bob");
    const seenByBob = await view(b, "alice");
    expect(seenByAlice?.phase).toBe("compare");
    expect(seenByBob?.phase).toBe("compare");
    // Whose start lost is B for the winner.
    expect(seenByAlice?.role).toBe(aliceTx === smaller ? "a" : "b");
    expect(seenByBob?.role).toBe(bobTx === smaller ? "a" : "b");
    expect(seenByBob?.emoji).toHaveLength(7);
    expect(seenByBob?.emoji).toEqual(seenByAlice?.emoji);
  });

  it("times out after 10 minutes on a tick, and the peer is told", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await step(a, "bob", "start");

    w.now += SAS_TIMEOUT_MS - 1;
    await a.client.tick(a.ctx);
    expect(await view(a, "bob")).not.toBeNull();
    w.now += 1;
    const ticked = await a.client.tick(a.ctx);
    await b.client.drain(b.ctx);

    expect(ticked).toEqual({ chats: ["bob"], pkmsgs: 0, waiting: false });
    expect(await sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "timeout"],
    ]);
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "timeout"],
    ]);
  });

  it("a step grappa refuses writes no row and is only logged: the SAS waits for its time", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.refuse = (o) => (o.verb === "msg" ? "rate-limited" : undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await step(a, "bob", "start");

      expect(warn).toHaveBeenCalledWith(
        "[e2e] a SAS step to bob was not sent (rate-limited); the SAS will time out",
      );
    } finally {
      warn.mockRestore();
    }
    expect((await rowsOf(a, "bob")).map((r) => r.kind)).toEqual(["out", "in", "sas_asked"]);
    expect(await view(a, "bob")).toEqual(expect.objectContaining({ phase: "started" }));
    await b.client.drain(b.ctx);
    expect(await view(b, "alice")).toBeNull();
  });

  it("another tab cancels a SAS whose page went away before it was confirmed", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const tab = w.tab(a);
    await step(a, "bob", "start");

    await tab.client.tick(tab.ctx);
    expect(await view(tab, "bob")).toEqual(expect.objectContaining({ here: false }));
    w.close(a);
    await tab.client.tick(tab.ctx);
    await b.client.drain(b.ctx);

    expect(await view(tab, "bob")).toBeNull();
    expect(await sasRows(tab, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "page-gone"],
    ]);
    expect(await sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "page-gone"],
    ]);
  });

  it("a SAS that ends in another tab takes its secret out of the page that held it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const tab = w.tab(a);
    await step(a, "bob", "start");
    expect(a.host.secrets.size).toBe(1);
    await b.client.drain(b.ctx);
    await step(b, "alice", "cancel");

    await tab.client.drain(tab.ctx);
    expect(await view(tab, "bob")).toBeNull();
    expect(a.host.secrets.size).toBe(1);
    await view(a, "bob");

    expect(a.host.secrets.size).toBe(0);
  });

  it("another tab drains the steps; only the page that started it shows the emoji, and any tab finishes it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const tab = w.tab(a);
    await step(a, "bob", "start");
    await b.client.drain(b.ctx);
    await step(b, "alice", "accept");
    await tab.client.drain(tab.ctx);
    await b.client.drain(b.ctx);
    await tab.client.drain(tab.ctx);

    expect(await view(tab, "bob")).toEqual(
      expect.objectContaining({ phase: "compare", here: false, emoji: null }),
    );
    // The page that holds the secret works the emoji out as it shows them.
    const emoji = (await view(a, "bob"))?.emoji;
    expect(emoji).toHaveLength(7);
    expect((await view(b, "alice"))?.emoji).toEqual(emoji);

    await step(a, "bob", "match");
    // Confirmed: the page that held the secret may go, the SAS goes on.
    w.close(a);
    await tab.client.tick(tab.ctx);
    await step(b, "alice", "match");
    await tab.client.drain(tab.ctx);

    expect(await verified(tab, "bob")).toBe(true);
    expect(await sasRows(tab, "bob")).toEqual([["sas_asked", "you"], ["verified"]]);
  });

  it("pinning the nick to another key by hand ends it: key-changed", async () => {
    const { w, a, b } = await pair();
    const carol = await w.join("carol");
    await chat(a, b);
    await step(a, "bob", "start");

    await a.client.pin(a.ctx, "bob", await keyOf(carol), true);

    expect(await recordOf(a, await keyOf(b))).toBeUndefined();
    expect((await rowsOf(a, "bob")).map((r) => r.kind)).toEqual([
      "out",
      "in",
      "sas_asked",
      "sas_cancelled",
      "pinned",
    ]);
    expect(await sasRows(a, "bob")).toContainEqual(["sas_cancelled", "you", "key-changed"]);
  });

  it("offers nothing to a nick with no key, and starts one SAS per key", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);

    await step(a, "nobody", "start");
    await step(a, "bob", "start");
    const first = await recordOf(a, await keyOf(b));
    await step(a, "bob", "start");

    expect(await view(a, "nobody")).toBeNull();
    expect(await recordOf(a, await keyOf(b))).toEqual(first);
    expect(w.grappa.sends.filter((s) => s.by === "alice" && s.target === "nobody")).toEqual([]);
  });
});
