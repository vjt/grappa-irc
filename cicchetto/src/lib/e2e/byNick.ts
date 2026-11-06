// issue 2453 — the records the E2E state keys by folded nick: a `ByKey`
// (`../byKey`, read and written through own properties only) whose key is the
// nick folded with the E2E `fold`, inside every helper here.
//
// The record stays a plain object, the JSON the sealed records already hold,
// so no stored record changes shape and none needs reading anew.

import { atKey, type ByKey, deleteKey, keyEntries, keyValues, setKey } from "../byKey";
import { fold } from "./wire";

declare const folded: unique symbol;

/**
 * Folded nick → T. An interface, not a type alias: an alias of an object type
 * converts to `Record<string, X>` without a cast (its implicit index
 * signature), and the record would be indexed again where it lands. Its own
 * brand, not `ByKey`'s: a `ByKey` helper would take an unfolded nick.
 */
export interface ByNick<T> {
  readonly [folded]: T;
}

const byKey = <T>(rec: ByNick<T>): ByKey<T> => rec as unknown as ByKey<T>;

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
  return atKey(byKey(rec), fold(nick));
}

/** Sets the entry of `nick`, folded. */
export function setNick<T>(rec: ByNick<T>, nick: string, value: T): void {
  setKey(byKey(rec), fold(nick), value);
}

/** Deletes the entry of `nick`, folded; none, nothing changes. */
export function deleteNick<T>(rec: ByNick<T>, nick: string): void {
  deleteKey(byKey(rec), fold(nick));
}

/** The entries, each under its folded nick, in the order they were first set. */
export const nickEntries = <T>(rec: ByNick<T>): [string, T][] => keyEntries(byKey(rec));

/** The values, in the order they were first set. */
export const nickValues = <T>(rec: ByNick<T>): T[] => keyValues(byKey(rec));
