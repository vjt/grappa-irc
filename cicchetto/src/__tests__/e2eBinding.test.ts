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
