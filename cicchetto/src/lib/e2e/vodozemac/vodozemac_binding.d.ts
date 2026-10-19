/* tslint:disable */
/* eslint-disable */

/**
 * An Olm account: the identity keys, the one-time keys and the fallback key.
 */
export class Account {
    free(): void;
    [Symbol.dispose](): void;
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_account_free: (a: number, b: number) => void;
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
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
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
