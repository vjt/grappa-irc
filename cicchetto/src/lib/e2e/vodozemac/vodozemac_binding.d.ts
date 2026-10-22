/* tslint:disable */
/* eslint-disable */

/**
 * An Olm account: the identity keys, the one-time keys and the fallback key.
 */
export class Account {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Opens the session a peer started with a pre-key message (the body of
     * a PKMSG, as bytes), and decrypts that first message. Uses up the
     * one-time key it was built on: store the account afterwards.
     */
    create_inbound_session(identity_key: string, message: Uint8Array): InboundSession;
    /**
     * Opens a session to a peer from its Curve25519 identity key and one of
     * its one-time (or fallback) keys, as a KEYS answer hands them out.
     */
    create_outbound_session(identity_key: string, one_time_key: string): Session;
    /**
     * The Curve25519 identity key.
     */
    curve25519_key(): string;
    /**
     * The Ed25519 identity key: what a peer pins.
     */
    ed25519_key(): string;
    /**
     * The fallback key if it is not yet marked as published.
     */
    fallback_key(): string | undefined;
    /**
     * Restores an account from what `pickle` returned.
     */
    static from_pickle(pickle: string): Account;
    /**
     * Generates a new fallback key, unpublished; the account keeps the
     * previous one too, so a session already opened with it still works.
     */
    generate_fallback_key(): void;
    /**
     * Generates `count` one-time keys, unpublished.
     */
    generate_one_time_keys(count: number): void;
    /**
     * Marks every unpublished one-time key and the fallback key as published.
     */
    mark_keys_as_published(): void;
    /**
     * The most one-time keys a server should hold for this account.
     */
    max_number_of_one_time_keys(): number;
    /**
     * A new account with fresh identity keys and no one-time keys.
     */
    constructor();
    /**
     * The one-time keys not yet marked as published, oldest first.
     */
    one_time_keys(): string[];
    /**
     * The whole account, private keys included, as JSON. The caller
     * encrypts it before it is stored anywhere.
     */
    pickle(): string;
    /**
     * Signs `message` (as UTF-8) with the Ed25519 identity key.
     */
    sign(message: string): string;
}

/**
 * An encrypted message: its Olm type and its bytes.
 */
export class Encrypted {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The message's bytes.
     */
    readonly body: Uint8Array;
    /**
     * 0 for a pre-key message (sent as PKMSG), 1 for a normal one (MSG).
     */
    readonly message_type: number;
}

/**
 * What `Account::create_inbound_session` returns: the session, taken once,
 * and the plaintext of the message that opened it.
 */
export class InboundSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The plaintext of the pre-key message.
     */
    plaintext(): Uint8Array;
    /**
     * The new session; `undefined` once taken.
     */
    take_session(): Session | undefined;
}

/**
 * An Olm session with one peer.
 */
export class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypts a message of `message_type` (0 pre-key, 1 normal) from its bytes.
     */
    decrypt(message_type: number, body: Uint8Array): Uint8Array;
    /**
     * Encrypts `plaintext`: a pre-key message (type 0) until the peer has
     * answered on this session, a normal message (type 1) after.
     */
    encrypt(plaintext: Uint8Array): Encrypted;
    /**
     * Restores a session from what `pickle` returned.
     */
    static from_pickle(pickle: string): Session;
    /**
     * The whole session, ratchet keys included, as JSON. The caller
     * encrypts it before it is stored anywhere.
     */
    pickle(): string;
    /**
     * The id both ends compute for this session; a pre-key message names
     * the same one (`pre_key_session_id`).
     */
    session_id(): string;
}

/**
 * The one spelling of a Curve25519 key: vodozemac's unpadded base64.
 */
export function canonical_curve25519(key: string): string;

/**
 * The one spelling of an Ed25519 key: vodozemac's unpadded base64.
 */
export function canonical_ed25519(key: string): string;

/**
 * The session id a pre-key message (as bytes) belongs to.
 */
export function pre_key_session_id(message: Uint8Array): string;

/**
 * Whether `signature` is `key`'s Ed25519 signature over `message` (as
 * UTF-8). False for anything malformed: a key or signature from the wire
 * is never a reason to throw.
 */
export function verify_ed25519(key: string, message: string, signature: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_account_free: (a: number, b: number) => void;
    readonly __wbg_encrypted_free: (a: number, b: number) => void;
    readonly __wbg_inboundsession_free: (a: number, b: number) => void;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly account_create_inbound_session: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly account_create_outbound_session: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly account_curve25519_key: (a: number, b: number) => void;
    readonly account_ed25519_key: (a: number, b: number) => void;
    readonly account_fallback_key: (a: number, b: number) => void;
    readonly account_from_pickle: (a: number, b: number, c: number) => void;
    readonly account_generate_fallback_key: (a: number) => void;
    readonly account_generate_one_time_keys: (a: number, b: number) => void;
    readonly account_mark_keys_as_published: (a: number) => void;
    readonly account_max_number_of_one_time_keys: (a: number) => number;
    readonly account_new: () => number;
    readonly account_one_time_keys: (a: number, b: number) => void;
    readonly account_pickle: (a: number, b: number) => void;
    readonly account_sign: (a: number, b: number, c: number, d: number) => void;
    readonly canonical_curve25519: (a: number, b: number, c: number) => void;
    readonly canonical_ed25519: (a: number, b: number, c: number) => void;
    readonly encrypted_body: (a: number, b: number) => void;
    readonly encrypted_message_type: (a: number) => number;
    readonly inboundsession_plaintext: (a: number, b: number) => void;
    readonly inboundsession_take_session: (a: number) => number;
    readonly pre_key_session_id: (a: number, b: number, c: number) => void;
    readonly session_decrypt: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly session_encrypt: (a: number, b: number, c: number, d: number) => void;
    readonly session_from_pickle: (a: number, b: number, c: number) => void;
    readonly session_pickle: (a: number, b: number) => void;
    readonly session_session_id: (a: number, b: number) => void;
    readonly verify_ed25519: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
