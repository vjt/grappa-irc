// Channel E2E (wire v3) — the Megolm adapter shim (`megolm.ts`) over a
// fake binding that implements the real wasm surface (`GroupSession` /
// `InboundGroupSession` as exported by the binding: `encrypt` returns a
// `GroupEncrypted` with `body` and `message_index`, `decrypt` a
// `GroupDecrypted` with `plaintext` and `message_index`). No real wasm
// runs here: these tests prove the shim translates between the adapter
// interface and the binding's shape, and that a binding without the
// Megolm exports fails loudly with `MegolmUnavailableError` instead of
// halfway through a send. The real binding is exercised in
// `e2eMegolmReal.test.ts`.
import { describe, expect, it } from "vitest";
import { type MegolmAdapter, MegolmUnavailableError, megolmFromBinding } from "../lib/e2e/megolm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A fake binding class pair implementing the assumed wasm surface, over a toy cipher. */
function fakeBinding() {
  type Stored = { sid: string; key: string; index: number; seen: number[] };
  const byKey = new Map<string, Stored>();
  let counter = 0;

  const toB64 = (text: string): string =>
    btoa(String.fromCharCode(...encoder.encode(text))).replace(/=+$/, "");
  const fromB64 = (b64: string): string =>
    decoder.decode(
      Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)),
    );

  class GroupSession {
    private readonly stored: Stored;

    constructor() {
      counter += 1;
      this.stored = { sid: `wasm-sid-${counter}`, key: `wasm-key-${counter}`, index: 0, seen: [] };
      byKey.set(this.stored.key, this.stored);
    }

    static from_pickle(pickle: string): GroupSession {
      const data = JSON.parse(pickle) as Stored;
      const session = new GroupSession();
      (session as unknown as { stored: Stored }).stored = { ...data, seen: [...data.seen] };
      byKey.set(data.key, (session as unknown as { stored: Stored }).stored);
      return session;
    }

    session_id(): string {
      return this.stored.sid;
    }

    message_index(): number {
      return this.stored.index;
    }

    encrypt(plaintext: Uint8Array): { body: string; message_index: number } {
      const body = JSON.stringify({
        sid: this.stored.sid,
        i: this.stored.index,
        body: decoder.decode(plaintext),
      });
      const out = { body: toB64(body), message_index: this.stored.index };
      this.stored.index += 1;
      return out;
    }

    session_key(): string {
      return this.stored.key;
    }

    pickle(): string {
      return JSON.stringify(this.stored);
    }

    free(): void {}
  }

  class InboundGroupSession {
    private readonly stored: Stored;

    constructor(sessionKey: string) {
      const found = byKey.get(sessionKey);
      if (found === undefined) throw new Error("unknown session key");
      this.stored = found;
    }

    static from_pickle(pickle: string): InboundGroupSession {
      const data = JSON.parse(pickle) as Stored;
      const session = new InboundGroupSession(data.key);
      (session as unknown as { stored: Stored }).stored = { ...data, seen: [...data.seen] };
      return session;
    }

    session_id(): string {
      return this.stored.sid;
    }

    decrypt(ciphertext: string): { plaintext: Uint8Array; message_index: number } {
      const parsed = JSON.parse(fromB64(ciphertext)) as { sid: string; i: number; body: string };
      if (parsed.sid !== this.stored.sid) throw new Error("not for this session");
      if (this.stored.seen.includes(parsed.i)) throw new Error("replayed index");
      this.stored.seen.push(parsed.i);
      return { plaintext: encoder.encode(parsed.body), message_index: parsed.i };
    }

    pickle(): string {
      return JSON.stringify(this.stored);
    }

    free(): void {}
  }

  return { GroupSession, InboundGroupSession };
}

describe("megolmFromBinding", () => {
  it("throws MegolmUnavailableError when the binding has no Megolm exports", () => {
    expect(() => megolmFromBinding({})).toThrow(MegolmUnavailableError);
    expect(() => megolmFromBinding(null)).toThrow(MegolmUnavailableError);
    expect(() => megolmFromBinding({ GroupSession: class {} })).toThrow(MegolmUnavailableError);
  });

  it("round-trips a session key and a message through the assumed wasm surface", () => {
    const adapter: MegolmAdapter = megolmFromBinding(fakeBinding());
    const outbound = adapter.createOutbound();
    const sid = outbound.sessionId();
    const key = outbound.sessionKey();
    expect(sid).toMatch(/^wasm-sid-/);
    const ciphertext = outbound.encrypt(encoder.encode("hello channel"));
    expect(ciphertext.index).toBe(0);
    expect(outbound.messageIndex()).toBe(1);
    const pickle = outbound.pickle();
    outbound.free();

    const inbound = adapter.importInbound(key);
    expect(inbound.sessionId()).toBe(sid);
    const read = inbound.decrypt(ciphertext.body);
    expect(decoder.decode(read.plaintext)).toBe("hello channel");
    expect(read.messageIndex).toBe(0);
    inbound.free();

    // Restored sessions continue the chain: the pickle held the index.
    const restored = adapter.restoreOutbound(pickle);
    expect(restored.sessionId()).toBe(sid);
    expect(restored.messageIndex()).toBe(1);
    const second = restored.encrypt(encoder.encode("second"));
    expect(second.index).toBe(1);
    restored.free();
    const inbound2 = adapter.importInbound(key);
    expect(() => inbound2.decrypt(second.body)).not.toThrow();
    inbound2.free();
  });

  it("refuses a bad session key at import, and a ciphertext of another session", () => {
    const adapter: MegolmAdapter = megolmFromBinding(fakeBinding());
    expect(() => adapter.importInbound("no-such-key")).toThrow();
    const outbound = adapter.createOutbound();
    const other = adapter.createOutbound();
    const ciphertext = outbound.encrypt(encoder.encode("for one"));
    const inbound = adapter.importInbound(other.sessionKey());
    expect(() => inbound.decrypt(ciphertext.body)).toThrow();
    outbound.free();
    other.free();
    inbound.free();
  });
});
