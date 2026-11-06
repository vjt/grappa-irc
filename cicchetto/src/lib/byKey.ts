// issue 2453 — a record keyed by a string a peer or the user chose: a nick,
// an alias, a typed verb, a file extension or type, a peer's own words.
//
// A plain object answers `rec[key]` and `key in rec` from Object.prototype as
// well as from its own entries, and the names of its members are valid
// strings: `constructor` and `__proto__` in lower case, `toString` and the
// rest where a key keeps its case. So a record keyed by a chosen string is read
// and written here only: an entry is an own property (`Object.hasOwn`), set by
// defining it, and a copy is a spread, which keeps every own entry.
//
// The record stays a plain object, so its JSON is unchanged: `JSON.parse`
// makes every key an own property and `JSON.stringify` writes each one back.
// The type has no index signature: tsc refuses `rec[key]` anywhere else.

declare const own: unique symbol;

/**
 * Key → T. An interface, not a type alias: an alias of an object type
 * converts to `Record<string, X>` without a cast (its implicit index
 * signature), and the record would be indexed again where it lands.
 */
export interface ByKey<T> {
  readonly [own]: T;
}

const plain = <T>(rec: ByKey<T>): Record<string, T> => rec as unknown as Record<string, T>;

/** A record with no entry. */
export const noKeys = <T>(): ByKey<T> => ({}) as ByKey<T>;

/** A record of the own entries of `rec`: a parsed record, or a literal table. */
export const keysOf = <T>(rec: Readonly<Record<string, T>>): ByKey<T> =>
  ({ ...rec }) as unknown as ByKey<T>;

/** The entry of `key`; undefined when it has none, or there is no record. */
export function atKey<T>(rec: ByKey<T> | undefined, key: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? plain(rec)[key] : undefined;
}

/** Sets the entry of `key`. */
export function setKey<T>(rec: ByKey<T>, key: string, value: T): void {
  Object.defineProperty(rec, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Deletes the entry of `key`; none, nothing changes. */
export function deleteKey<T>(rec: ByKey<T>, key: string): void {
  delete plain(rec)[key];
}

/** A copy of `rec` (none: of a record with no entry) with `key` set to `value`. */
export function withKey<T>(rec: ByKey<T> | undefined, key: string, value: T): ByKey<T> {
  const next = { ...rec } as ByKey<T>;
  setKey(next, key, value);
  return next;
}

/** A copy of `rec` without the entry of `key`. */
export function withoutKey<T>(rec: ByKey<T>, key: string): ByKey<T> {
  const next = { ...rec };
  deleteKey(next, key);
  return next;
}

/** The entries, in `Object.entries` order. */
export const keyEntries = <T>(rec: ByKey<T>): [string, T][] => Object.entries(plain(rec));

/** The values, in `Object.values` order. */
export const keyValues = <T>(rec: ByKey<T>): T[] => Object.values(plain(rec));
