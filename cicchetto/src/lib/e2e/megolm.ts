// Channel E2E (wire v3, CLIENT_PROTOCOL §4f) — the one place that talks
// to vodozemac's Megolm half. Everything else (the group session store,
// the rotation rules, the channel send/receive paths) talks to this
// adapter's interface, never to the wasm binding directly.
//
// THE CONTRACT FOR THE RUST WORKER. The wasm binding does not export
// Megolm yet (vodozemac 0.11.1 has it in the crate; the binding in
// `cicchetto/wasm/vodozemac-binding` needs `GroupSession` and
// `InboundGroupSession` added, same conventions as the Olm half in
// `lib.rs`: snake_case methods, keys and ciphertexts as standard base64
// unpadded, pickles as JSON strings from `serde_json`, `from_pickle` /
// `pickle` / `free`. The surface this adapter assumes:
//
//   GroupSession::new() -> GroupSession
//   GroupSession::from_pickle(pickle: string) -> GroupSession
//   GroupSession::session_id() -> string        (base64 of the signing key)
//   GroupSession::message_index() -> number
//   GroupSession::encrypt(plaintext: Uint8Array) -> string
//       (the MegolmMessage, standard base64 unpadded)
//   GroupSession::session_key() -> string       (base64 SessionKey)
//   GroupSession::pickle() -> string
//   InboundGroupSession::new(session_key: string) -> InboundGroupSession
//   InboundGroupSession::from_pickle(pickle: string) -> InboundGroupSession
//   InboundGroupSession::session_id() -> string
//   InboundGroupSession::decrypt(ciphertext: string) -> DecryptedMessage
//       ({ plaintext: Uint8Array, message_index: number })
//   InboundGroupSession::pickle() -> string
//
// The names above are the vodozemac crate's (`GroupSession::session_key`,
// `InboundGroupSession::new(&SessionKey, ...)`, `decrypt` returning a
// `DecryptedMessage` with `plaintext` and `message_index`), spelled the
// way this repo's binding spells the Olm half. If the Rust worker's final
// API differs in names, shapes, or the encrypt/decrypt spelling (bytes
// instead of base64 strings), ONLY this file changes: the interface below
// is what the rest of the client is written against, and `megolm.ts` is
// the reconciliation point.
//
// Until the exports land, `loadMegolm` throws `MegolmUnavailableError`
// and channel E2E degrades to undecryptable (the DM path's behaviour for
// a message that cannot be read); nothing here imports the vendored
// binding's `.d.ts` Megolm types, because they do not exist yet.

import { loadOlm } from "./olm";
import { base64Unpadded, unbase64 } from "./wire";

/** The binding has no Megolm exports yet, or refused to load them. */
export class MegolmUnavailableError extends Error {}

/**
 * An outbound (sending) Megolm group session: one per channel, per
 * sender. `encrypt` advances the chain index; the pickle after an
 * encrypt is the one to store, never the one from before it.
 */
export interface MegolmOutboundSession {
  /** The session id: the base64 of the session's Ed25519 signing key. */
  sessionId(): string;
  /** The chain index the next `encrypt` writes. */
  messageIndex(): number;
  /** The MegolmMessage for `plaintext`, standard base64 unpadded. */
  encrypt(plaintext: Uint8Array): string;
  /** The session key to distribute (base64): what a peer imports. */
  sessionKey(): string;
  /** The whole session, ratchet included, as a string. Store it sealed. */
  pickle(): string;
  free(): void;
}

/**
 * An inbound (receiving) Megolm group session: one per (channel, sender,
 * session id). `decrypt` advances the ratchet; the pickle after a decrypt
 * is the one to store, never the one from before it.
 */
export interface MegolmInboundSession {
  /** The session id this session decrypts for. */
  sessionId(): string;
  /**
   * The plaintext of `ciphertext` (a MegolmMessage, base64), and the
   * chain index it was encrypted at. Throws when the message is not for
   * this session, its MAC fails, or its index was already read.
   */
  decrypt(ciphertext: string): { plaintext: Uint8Array; messageIndex: number };
  /** The whole session, ratchet included, as a string. Store it sealed. */
  pickle(): string;
  free(): void;
}

/** What the group session store needs of Megolm, and nothing more. */
export interface MegolmAdapter {
  /** A fresh outbound session: a new epoch. */
  createOutbound(): MegolmOutboundSession;
  /** The outbound session `pickle` (from `pickle()`) held, advanced. */
  restoreOutbound(pickle: string): MegolmOutboundSession;
  /** An inbound session from a distributed session key (a gkey's `key`). */
  importInbound(sessionKey: string): MegolmInboundSession;
  /** The inbound session `pickle` (from `pickle()`) held, advanced. */
  restoreInbound(pickle: string): MegolmInboundSession;
}

// --- the assumed wasm surface (see the header) ---------------------------

type WasmGroupSession = {
  session_id(): string;
  message_index(): number;
  encrypt(plaintext: Uint8Array): string | Uint8Array;
  session_key(): string;
  pickle(): string;
  free(): void;
};

type WasmGroupSessionCtor = {
  new (): WasmGroupSession;
  from_pickle(pickle: string): WasmGroupSession;
};

type WasmDecryptedMessage = {
  plaintext: Uint8Array | (() => Uint8Array);
  message_index: number | (() => number);
};

type WasmInboundGroupSession = {
  session_id(): string;
  decrypt(ciphertext: string): WasmDecryptedMessage;
  pickle(): string;
  free(): void;
};

type WasmInboundGroupSessionCtor = {
  new (sessionKey: string): WasmInboundGroupSession;
  from_pickle(pickle: string): WasmInboundGroupSession;
};

type WasmMegolmBinding = {
  GroupSession: WasmGroupSessionCtor;
  InboundGroupSession: WasmInboundGroupSessionCtor;
};

const encoder = new TextEncoder();

function unavailable(what: string): MegolmUnavailableError {
  return new MegolmUnavailableError(
    `the wasm binding has no Megolm ${what} yet (the Rust worker's slice has not landed)`,
  );
}

function needFn(obj: unknown, name: string, what: string): void {
  // A class is a function, not an object: the constructors under test are
  // classes, so both spellings count.
  if (
    (typeof obj !== "object" && typeof obj !== "function") ||
    obj === null ||
    typeof (obj as Record<string, unknown>)[name] !== "function"
  ) {
    throw unavailable(what);
  }
}

/** The `Uint8Array` of a value the binding hands back as bytes or base64 text. */
function asBytes(value: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof value === "string" ? unbase64(value) : (value as Uint8Array<ArrayBuffer>);
}

/** A property of a wasm-bindgen struct: a getter, or a method, either way. */
function asValue<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

/**
 * An adapter over a binding module that carries the assumed surface.
 * Throws `MegolmUnavailableError` when a constructor or a method it needs
 * is missing, so a binding predating the Rust worker's slice fails here,
 * loudly, instead of halfway through a send.
 */
export function megolmFromBinding(binding: unknown): MegolmAdapter {
  const b = binding as Partial<WasmMegolmBinding> | null;
  if (typeof b?.GroupSession !== "function") throw unavailable("GroupSession");
  if (typeof b?.InboundGroupSession !== "function") throw unavailable("InboundGroupSession");
  for (const name of ["from_pickle"] as const) {
    needFn(b.GroupSession, name, "GroupSession.from_pickle");
    needFn(b.InboundGroupSession, name, "InboundGroupSession.from_pickle");
  }
  for (const name of ["session_id", "message_index", "encrypt", "session_key", "pickle", "free"]) {
    if (typeof b.GroupSession.prototype[name as keyof WasmGroupSession] !== "function") {
      throw unavailable(`GroupSession.${name}`);
    }
  }
  for (const name of ["session_id", "decrypt", "pickle", "free"]) {
    if (
      typeof b.InboundGroupSession.prototype[name as keyof WasmInboundGroupSession] !== "function"
    ) {
      throw unavailable(`InboundGroupSession.${name}`);
    }
  }
  const GroupSession = b.GroupSession;
  const InboundGroupSession = b.InboundGroupSession;

  const wrapOutbound = (wasm: WasmGroupSession): MegolmOutboundSession => ({
    sessionId: () => wasm.session_id(),
    messageIndex: () => wasm.message_index(),
    encrypt: (plaintext) => {
      const out = wasm.encrypt(plaintext);
      return typeof out === "string" ? out : base64Unpadded(out);
    },
    sessionKey: () => wasm.session_key(),
    pickle: () => wasm.pickle(),
    free: () => wasm.free(),
  });
  const wrapInbound = (wasm: WasmInboundGroupSession): MegolmInboundSession => ({
    sessionId: () => wasm.session_id(),
    decrypt: (ciphertext) => {
      const out = wasm.decrypt(ciphertext);
      return {
        plaintext: asBytes(asValue(out.plaintext)),
        messageIndex: asValue(out.message_index),
      };
    },
    pickle: () => wasm.pickle(),
    free: () => wasm.free(),
  });

  return {
    createOutbound: () => wrapOutbound(new GroupSession()),
    restoreOutbound: (pickle) => wrapOutbound(GroupSession.from_pickle(pickle)),
    importInbound: (sessionKey) => wrapInbound(new InboundGroupSession(sessionKey)),
    restoreInbound: (pickle) => wrapInbound(InboundGroupSession.from_pickle(pickle)),
  };
}

let loaded: MegolmAdapter | undefined;

/**
 * The Megolm adapter over the loaded binding. The binding module itself
 * is cached by `loadOlm`; a successful adapter is cached here. A failure
 * is not cached, so a binding that gains the exports (a rebuild, a new
 * page) is picked up by the next call.
 */
export async function loadMegolm(): Promise<MegolmAdapter> {
  loaded ??= megolmFromBinding(await loadOlm());
  return loaded;
}

/** The UTF-8 bytes of `text`, for `encrypt`. */
export function megolmBytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}
