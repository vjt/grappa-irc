// issue 2453 — the records the E2E state keys by folded nick.
//
// A nick is the peer's to choose, and two valid ones fold to the name of an
// Object.prototype member: `constructor` and `__proto__`. Indexed as a plain
// object, a record answers `Object` or `Object.prototype` where it holds no
// entry for them, and an assignment to `__proto__` runs the prototype's
// setter: a string is thrown away, an object becomes the record's prototype.
// So a record keyed by nick is read and written here only: an entry is an own
// property (`Object.hasOwn`), set by defining it.
//
// The record stays a plain object, the JSON the sealed records already hold:
// `JSON.parse` makes `__proto__` an own property and `JSON.stringify` writes
// it back, so no stored record changes shape and none needs reading anew. The
// type has no index signature: tsc refuses `rec[nick]` anywhere else.

import { fold } from "./wire";

declare const folded: unique symbol;

/**
 * Folded nick → T. An interface, not a type alias: an alias of an object type
 * converts to `Record<string, X>` without a cast (its implicit index
 * signature), and the record would be indexed again where it lands.
 */
export interface ByNick<T> {
  readonly [folded]: T;
}

const plain = <T>(rec: ByNick<T>): Record<string, T> => rec as unknown as Record<string, T>;

/** A record with no entry. */
export const noNicks = <T>(): ByNick<T> => ({}) as ByNick<T>;

/** A record of `entries`, each under its nick folded: of two spellings of one nick, the later stands. */
export function nicksFrom<T>(entries: Iterable<readonly [string, T]>): ByNick<T> {
  const rec = noNicks<T>();
  for (const [nick, value] of entries) setNick(rec, nick, value);
  return rec;
}

/** The entry of `nick`, folded; undefined when it has none. */
export function atNick<T>(rec: ByNick<T>, nick: string): T | undefined {
  const key = fold(nick);
  return Object.hasOwn(rec, key) ? plain(rec)[key] : undefined;
}

/** Sets the entry of `nick`, folded. */
export function setNick<T>(rec: ByNick<T>, nick: string, value: T): void {
  Object.defineProperty(rec, fold(nick), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Deletes the entry of `nick`, folded; none, nothing changes. */
export function deleteNick<T>(rec: ByNick<T>, nick: string): void {
  delete plain(rec)[fold(nick)];
}

/** The entries, each under its folded nick, in the order they were first set. */
export const nickEntries = <T>(rec: ByNick<T>): [string, T][] => Object.entries(plain(rec));

/** The values, in the order they were first set. */
export const nickValues = <T>(rec: ByNick<T>): T[] => Object.values(plain(rec));
