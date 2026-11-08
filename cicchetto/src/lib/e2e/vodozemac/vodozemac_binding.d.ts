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
 * One side of an ECIES channel before it exists (MSC4108 shape): an
 * ephemeral Curve25519 key pair and the info string both sides must share.
 * The secret half cannot be pickled, so a channel lives in the page that
 * made it.
 */
export class Ecies {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Accepts the other side's initial message (`EciesOutbound.message`).
     * Uses this object up, failed or not.
     */
    establish_inbound_channel(initial: string): EciesInbound;
    /**
     * Opens a channel to `their_key` with `plaintext` as the first message.
     * Uses this object up, failed or not.
     */
    establish_outbound_channel(their_key: string, plaintext: Uint8Array): EciesOutbound;
    /**
     * A new ephemeral key pair under `info`.
     */
    constructor(info: string);
    /**
     * The public half, shown to the other side (in the QR).
     */
    public_key(): string;
}

/**
 * What `Ecies::establish_inbound_channel` returns: the channel, taken once,
 * and the plaintext of the initial message.
 */
export class EciesInbound {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The channel; `undefined` once taken.
     */
    take_channel(): EstablishedEcies | undefined;
    /**
     * The plaintext of the initial message.
     */
    readonly plaintext: Uint8Array;
}

/**
 * What `Ecies::establish_outbound_channel` returns: the channel, taken
 * once, and the initial message to send (`ciphertext|key`).
 */
export class EciesOutbound {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The channel; `undefined` once taken.
     */
    take_channel(): EstablishedEcies | undefined;
    /**
     * The initial message as vodozemac encodes it.
     */
    readonly message: string;
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
 * An ECIES channel both sides have established: the check code to compare
 * out of band, and the messages.
 */
export class EstablishedEcies {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The two-digit check code, 0 to 99 (a leading zero is allowed, so the
     * caller renders it with two digits).
     */
    check_code(): number;
    /**
     * Decrypts a message from `encrypt`. Each message is read once and in
     * order: a failed attempt may still have moved the counter.
     */
    decrypt(message: string): Uint8Array;
    /**
     * Encrypts `plaintext`; the message as vodozemac encodes it.
     */
    encrypt(plaintext: Uint8Array): string;
}

/**
 * A SAS once the keys are exchanged: the emoji to compare, and the MACs.
 */
export class EstablishedSas {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The MAC of `input` under a key this secret derives under `info`.
     */
    calculate_mac(input: string, info: string): string;
    /**
     * The 7 emoji, as indices into the Matrix SAS emoji table, of the
     * bytes this secret derives under `info`.
     */
    emoji_indices(info: string): Uint8Array;
}

/**
 * What `InboundGroupSession::decrypt` returns: the plaintext and the chain
 * index it was encrypted at.
 */
export class GroupDecrypted {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The chain index the message was encrypted at: the `i` of the v3
     * group payload. Compare it with `first_known_index` to tell a replay
     * from a new message.
     */
    readonly message_index: number;
    /**
     * The decrypted plaintext.
     */
    readonly plaintext: Uint8Array;
}

/**
 * What `GroupSession::encrypt` returns: the chain index and the ciphertext.
 */
export class GroupEncrypted {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The ciphertext, base64 standard unpadded: the `body` of the v3
     * group payload.
     */
    readonly body: string;
    /**
     * The chain index this message was encrypted at: the `i` of the v3
     * group payload.
     */
    readonly message_index: number;
}

/**
 * An outbound Megolm group session: one sender's key for one channel
 * epoch. It holds the signing key pair, so it lives on the device that
 * sends, never on a receiver.
 */
export class GroupSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Encrypts `plaintext` under the session. The returned message carries
     * the chain index it was encrypted at.
     */
    encrypt(plaintext: Uint8Array): GroupEncrypted;
    /**
     * Restores a session from what `pickle` returned.
     */
    static from_pickle(pickle: string): GroupSession;
    /**
     * The chain index the next `encrypt` will use.
     */
    message_index(): number;
    /**
     * A new session with a fresh ratchet and signing key pair.
     */
    constructor();
    /**
     * The whole session, signing key included, as JSON. The caller
     * encrypts it before it is stored anywhere.
     */
    pickle(): string;
    /**
     * The session id: the Ed25519 public key of this session, base64
     * standard unpadded. This is the `sid` of the v3 group payload and of
     * the `gkey` that distributes the key.
     */
    session_id(): string;
    /**
     * The session key to send to the other members, inside the pairwise
     * Olm DM and never in the clear: the signed session key, base64
     * standard unpadded. A receiver builds its `InboundGroupSession`
     * from it.
     */
    session_key(): string;
}

/**
 * An inbound Megolm group session: one sender's key, held by a receiver.
 * It has the public key only, so it can decrypt and never encrypt.
 */
export class InboundGroupSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Permanently forgets every message key below `index`: messages
     * encrypted before it can no longer be decrypted. False when the
     * session is already past `index`.
     */
    advance_to(index: number): boolean;
    /**
     * Decrypts a group message: the `body` of the v3 group payload,
     * base64 standard unpadded (padding is tolerated). The returned
     * message carries the chain index it was encrypted at.
     */
    decrypt(message: string): GroupDecrypted;
    /**
     * The unsigned key for this session at `index`, base64 standard
     * unpadded: hand it to a member that joined late, or to your other
     * devices. `undefined` when the session has ratcheted past `index`.
     */
    export_at(index: number): string | undefined;
    /**
     * The unsigned key at the first known index: the widest key this
     * session can still hand out.
     */
    export_at_first_known_index(): string;
    /**
     * The lowest chain index this session can still decrypt. Messages
     * encrypted below it are unreadable: the key was handed out late, or
     * the session was advanced past them.
     */
    first_known_index(): number;
    /**
     * Restores a session from what `pickle` returned.
     */
    static from_pickle(pickle: string): InboundGroupSession;
    /**
     * Builds the session from an unsigned exported key (`export_at`,
     * `export_at_first_known_index`). There is no signature to check, so
     * only take one from a source you already trust: a member you
     * verified, or your own store.
     */
    static import(exported_key: string): InboundGroupSession;
    /**
     * Builds the session from the signed session key the sender shared
     * (`GroupSession::session_key`): the signature is verified on decode,
     * so a key that is not this session's (`sid`) fails here.
     */
    constructor(session_key: string);
    /**
     * The whole session, ratchet included, as JSON. The caller encrypts
     * it before it is stored anywhere.
     */
    pickle(): string;
    /**
     * The session id: the Ed25519 public key of the sender's session,
     * base64 standard unpadded. This is the `sid` of the v3 group payload.
     */
    session_id(): string;
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
 * One side of a SAS verification before the keys are exchanged: an
 * ephemeral Curve25519 key pair. vodozemac keeps the secret half in a type
 * that cannot be pickled, so a SAS lives in the page that made it.
 */
export class Sas {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The shared secret with the peer's public half. Uses this object up,
     * failed or not: vodozemac refuses a key that makes no secret.
     */
    diffie_hellman(their_key: string): EstablishedSas;
    /**
     * A new ephemeral key pair.
     */
    constructor();
    /**
     * The public half, sent to the peer in `sas.key`.
     */
    public_key(): string;
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
     * Whether this session has decrypted a message from the peer: true on
     * an inbound session from the start, on an outbound one after the first
     * answer. Until then `encrypt` yields pre-key messages.
     */
    has_received_message(): boolean;
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
 * SHA-256 of `data`: the device ids and the binding hash are cut from it.
 */
export function sha256(data: Uint8Array): Uint8Array;

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
    readonly __wbg_ecies_free: (a: number, b: number) => void;
    readonly __wbg_eciesinbound_free: (a: number, b: number) => void;
    readonly __wbg_eciesoutbound_free: (a: number, b: number) => void;
    readonly __wbg_encrypted_free: (a: number, b: number) => void;
    readonly __wbg_establishedecies_free: (a: number, b: number) => void;
    readonly __wbg_establishedsas_free: (a: number, b: number) => void;
    readonly __wbg_groupdecrypted_free: (a: number, b: number) => void;
    readonly __wbg_groupencrypted_free: (a: number, b: number) => void;
    readonly __wbg_groupsession_free: (a: number, b: number) => void;
    readonly __wbg_inboundgroupsession_free: (a: number, b: number) => void;
    readonly __wbg_inboundsession_free: (a: number, b: number) => void;
    readonly __wbg_sas_free: (a: number, b: number) => void;
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
    readonly ecies_establish_inbound_channel: (a: number, b: number, c: number, d: number) => void;
    readonly ecies_establish_outbound_channel: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly ecies_new: (a: number, b: number) => number;
    readonly ecies_public_key: (a: number, b: number) => void;
    readonly eciesinbound_plaintext: (a: number, b: number) => void;
    readonly eciesinbound_take_channel: (a: number) => number;
    readonly eciesoutbound_message: (a: number, b: number) => void;
    readonly eciesoutbound_take_channel: (a: number) => number;
    readonly encrypted_body: (a: number, b: number) => void;
    readonly encrypted_message_type: (a: number) => number;
    readonly establishedecies_check_code: (a: number) => number;
    readonly establishedecies_decrypt: (a: number, b: number, c: number, d: number) => void;
    readonly establishedecies_encrypt: (a: number, b: number, c: number, d: number) => void;
    readonly establishedsas_calculate_mac: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly establishedsas_emoji_indices: (a: number, b: number, c: number, d: number) => void;
    readonly groupdecrypted_message_index: (a: number) => number;
    readonly groupdecrypted_plaintext: (a: number, b: number) => void;
    readonly groupencrypted_body: (a: number, b: number) => void;
    readonly groupencrypted_message_index: (a: number) => number;
    readonly groupsession_encrypt: (a: number, b: number, c: number) => number;
    readonly groupsession_from_pickle: (a: number, b: number, c: number) => void;
    readonly groupsession_message_index: (a: number) => number;
    readonly groupsession_new: () => number;
    readonly groupsession_pickle: (a: number, b: number) => void;
    readonly groupsession_session_id: (a: number, b: number) => void;
    readonly groupsession_session_key: (a: number, b: number) => void;
    readonly inboundgroupsession_advance_to: (a: number, b: number) => number;
    readonly inboundgroupsession_decrypt: (a: number, b: number, c: number, d: number) => void;
    readonly inboundgroupsession_export_at: (a: number, b: number, c: number) => void;
    readonly inboundgroupsession_export_at_first_known_index: (a: number, b: number) => void;
    readonly inboundgroupsession_first_known_index: (a: number) => number;
    readonly inboundgroupsession_from_pickle: (a: number, b: number, c: number) => void;
    readonly inboundgroupsession_import: (a: number, b: number, c: number) => void;
    readonly inboundgroupsession_new: (a: number, b: number, c: number) => void;
    readonly inboundgroupsession_pickle: (a: number, b: number) => void;
    readonly inboundgroupsession_session_id: (a: number, b: number) => void;
    readonly inboundsession_plaintext: (a: number, b: number) => void;
    readonly inboundsession_take_session: (a: number) => number;
    readonly pre_key_session_id: (a: number, b: number, c: number) => void;
    readonly sas_diffie_hellman: (a: number, b: number, c: number, d: number) => void;
    readonly sas_new: () => number;
    readonly sas_public_key: (a: number, b: number) => void;
    readonly session_decrypt: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly session_encrypt: (a: number, b: number, c: number, d: number) => void;
    readonly session_from_pickle: (a: number, b: number, c: number) => void;
    readonly session_has_received_message: (a: number) => number;
    readonly session_pickle: (a: number, b: number) => void;
    readonly session_session_id: (a: number, b: number) => void;
    readonly sha256: (a: number, b: number, c: number) => void;
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
