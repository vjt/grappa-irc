// A fake Megolm adapter for the channel E2E tests: no wasm, no crypto,
// just the adapter contract. A ciphertext is the base64 of a JSON object
// naming the session id, the chain index, and the plaintext; an inbound
// session refuses a ciphertext of another session id, and an index it
// already read (the replay a real Megolm session refuses). Session keys
// are `fake-key-<sid>`; pickles are JSON. The fake models the contract
// in `megolm.ts` closely enough to prove the store and the orchestration;
// it proves nothing about vodozemac itself.

import type {
  MegolmAdapter,
  MegolmInboundSession,
  MegolmOutboundSession,
} from "../../lib/e2e/megolm";
import { base64Unpadded, unbase64 } from "../../lib/e2e/wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Ciphertext = { sid: string; i: number; body: string };

class FakeOutbound implements MegolmOutboundSession {
  private index: number;

  constructor(
    private readonly sidValue: string,
    private readonly keyValue: string,
    index = 0,
  ) {
    this.index = index;
  }

  sessionId(): string {
    return this.sidValue;
  }

  messageIndex(): number {
    return this.index;
  }

  encrypt(plaintext: Uint8Array): string {
    const body = base64Unpadded(plaintext);
    const ciphertext: Ciphertext = { sid: this.sidValue, i: this.index, body };
    this.index += 1;
    return base64Unpadded(encoder.encode(JSON.stringify(ciphertext)));
  }

  sessionKey(): string {
    return this.keyValue;
  }

  pickle(): string {
    return JSON.stringify({ sid: this.sidValue, key: this.keyValue, index: this.index });
  }

  free(): void {}
}

class FakeInbound implements MegolmInboundSession {
  private readonly seen: Set<number>;

  constructor(
    private readonly sidValue: string,
    seen: number[] = [],
  ) {
    this.seen = new Set(seen);
  }

  sessionId(): string {
    return this.sidValue;
  }

  decrypt(ciphertext: string): { plaintext: Uint8Array; messageIndex: number } {
    let parsed: Ciphertext;
    try {
      parsed = JSON.parse(decoder.decode(unbase64(ciphertext))) as Ciphertext;
    } catch {
      throw new Error("not a fake ciphertext");
    }
    if (parsed.sid !== this.sidValue) throw new Error("not for this session");
    if (this.seen.has(parsed.i)) throw new Error("replayed index");
    this.seen.add(parsed.i);
    return { plaintext: unbase64(parsed.body), messageIndex: parsed.i };
  }

  pickle(): string {
    return JSON.stringify({ sid: this.sidValue, seen: [...this.seen] });
  }

  free(): void {}
}

/** A fake adapter: each `createOutbound` mints a new `fake-sid-N` epoch. */
export class FakeMegolmAdapter implements MegolmAdapter {
  private counter = 0;

  createOutbound(): MegolmOutboundSession {
    this.counter += 1;
    const sid = `fake-sid-${this.counter}`;
    return new FakeOutbound(sid, `fake-key-${sid}`);
  }

  restoreOutbound(pickle: string): MegolmOutboundSession {
    const data = JSON.parse(pickle) as { sid: string; key: string; index: number };
    return new FakeOutbound(data.sid, data.key, data.index);
  }

  importInbound(sessionKey: string): MegolmInboundSession {
    if (!sessionKey.startsWith("fake-key-") || sessionKey === "fake-key-") {
      throw new Error("not a fake session key");
    }
    return new FakeInbound(sessionKey.slice("fake-key-".length));
  }

  restoreInbound(pickle: string): MegolmInboundSession {
    const data = JSON.parse(pickle) as { sid: string; seen: number[] };
    return new FakeInbound(data.sid, data.seen);
  }
}

/** A fresh fake adapter. */
export function fakeMegolmAdapter(): MegolmAdapter {
  return new FakeMegolmAdapter();
}
