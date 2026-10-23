// issue 2430 — the two exports MD-2 adds to the vodozemac binding, against the
// real wasm: `Session.has_received_message` (is an outbound body going to be a
// pre-key message?) and `sha256` (device ids, the binding hash).
import { describe, expect, it } from "vitest";
import { olm } from "./helpers/olm";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("vodozemac binding: Session.has_received_message", () => {
  function pair() {
    const o = olm();
    const alice = new o.Account();
    const bob = new o.Account();
    bob.generate_one_time_keys(1);
    const otk = bob.one_time_keys()[0] as string;
    const outbound = alice.create_outbound_session(bob.curve25519_key(), otk);
    return { alice, bob, outbound };
  }

  it("is false on a fresh outbound session", () => {
    expect(pair().outbound.has_received_message()).toBe(false);
  });

  it("is true on an inbound session made from a pre-key message", () => {
    const { alice, bob, outbound } = pair();
    const first = outbound.encrypt(new TextEncoder().encode("hi"));
    const inbound = bob.create_inbound_session(alice.curve25519_key(), first.body);
    const session = inbound.take_session();
    expect(session?.has_received_message()).toBe(true);
  });

  it("turns true on the outbound side once the peer's reply is decrypted", () => {
    const { alice, bob, outbound } = pair();
    const first = outbound.encrypt(new TextEncoder().encode("hi"));
    const inbound = bob.create_inbound_session(alice.curve25519_key(), first.body);
    const session = inbound.take_session();
    const reply = session?.encrypt(new TextEncoder().encode("yo"));
    expect(reply?.message_type).toBe(1);
    expect(outbound.has_received_message()).toBe(false);
    outbound.decrypt(1, reply?.body ?? new Uint8Array());
    expect(outbound.has_received_message()).toBe(true);
  });
});

describe("vodozemac binding: sha256", () => {
  it("hashes the FIPS 180 test vector 'abc'", () => {
    const digest = olm().sha256(new TextEncoder().encode("abc"));
    expect(hex(digest)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("vodozemac binding: ecies", () => {
  const INFO = "irc-e2e:v2:pair";
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  function taken<T>(c: T | undefined): T {
    if (c === undefined) throw new Error("the channel was already taken");
    return c;
  }

  function channel() {
    const o = olm();
    const g = new o.Ecies(INFO);
    const gKey = g.public_key();
    const out = new o.Ecies(INFO).establish_outbound_channel(gKey, utf8("hello"));
    const message = out.message;
    const s = taken(out.take_channel());
    const inbound = g.establish_inbound_channel(message);
    const plaintext = inbound.plaintext;
    const gc = taken(inbound.take_channel());
    return { s, gc, message, plaintext };
  }

  it("ecies: the two sides of a channel show the same check code and read each other's messages", () => {
    const { s, gc, plaintext } = channel();
    expect(text(plaintext)).toBe("hello");
    expect(s.check_code()).toBe(gc.check_code());
    expect(s.check_code()).toBeGreaterThanOrEqual(0);
    expect(s.check_code()).toBeLessThanOrEqual(99);
    expect(text(gc.decrypt(s.encrypt(utf8("to holder"))))).toBe("to holder");
    expect(text(s.decrypt(gc.encrypt(utf8("to joiner"))))).toBe("to joiner");
  });

  it("ecies: another info string gives another check code or no channel", () => {
    const o = olm();
    const g = new o.Ecies("x");
    const out = new o.Ecies(INFO).establish_outbound_channel(g.public_key(), utf8("hello"));
    const sCode = taken(out.take_channel()).check_code();
    let gCode: number | undefined;
    try {
      gCode = taken(g.establish_inbound_channel(out.message).take_channel()).check_code();
    } catch {
      gCode = undefined;
    }
    expect(gCode === undefined || gCode !== sCode).toBe(true);
  });

  it("ecies: a message decrypted twice fails the second time", () => {
    const { s, gc } = channel();
    const m = s.encrypt(utf8("once"));
    expect(text(gc.decrypt(m))).toBe("once");
    expect(() => gc.decrypt(m)).toThrow();
  });

  it('ecies: an initial message holds a "|" (the reason the relay payload is wrapped)', () => {
    expect(channel().message.includes("|")).toBe(true);
  });

  it("ecies: a non-canonical peer key is refused", () => {
    const o = olm();
    expect(() =>
      new o.Ecies(INFO).establish_outbound_channel("x".repeat(43), utf8("hi")),
    ).toThrow();
  });

  it("ecies: a malformed initial message is refused", () => {
    const o = olm();
    expect(() => new o.Ecies(INFO).establish_inbound_channel("no-separator")).toThrow();
  });
});
