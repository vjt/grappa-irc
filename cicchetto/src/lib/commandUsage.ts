// issue 2584 — which commands the `/` menu offers, and in which order.
//
// The order is "most used first", and "most used" is per SUBJECT, synced
// across its devices (vjt's ruling, comment 6694918014): the counts live in
// the server's user_settings and this store only mirrors them, the way
// aliasList.ts mirrors the aliases. cic writes them, one verb per command that
// goes out (`countCommand`, called by compose.ts), because only cic sees the
// verb as typed.
//
// No event carries them (vjt's ruling, Q3): another open device picks new
// counts up at its next user-topic (re)join, where userTopic.ts calls
// `refreshCommandCounts`. The device that sends is current at once, because
// the POST answers the whole map.
//
// ## Keyed off the protocol number, never off a 404
//
// Below protocol 61 the routes do not exist, and the GET does not say so: an
// unknown GET path falls through to the web app's catch-all and answers 200
// text/html (CLIENT_PROTOCOL.md §8f, measured). So both doors ask
// `serverProtocol()` first and stay silent on an older server, or on one that
// has not named its protocol yet (the join reply sets it before any send).
// The menu then orders by the default list alone.
//
// ## A refused count is a lost count
//
// The POST is a metered write like any other and can be refused (429). That
// loses one count, which is logged, and never touches the command that was
// sent: no banner, nothing thrown at the sender.

import { createSignal } from "solid-js";
import { aliases } from "./aliasList";
import { token } from "./auth";
import { atKey, keyEntries, noKeys } from "./byKey";
import { identityScopedStore } from "./identityScopedStore";
import { serverProtocol } from "./serverProtocol";
import { BUILTIN_VERBS, builtinDescription } from "./slashCommands";
import { type CommandCounts, getCommandCounts, postCommandCount } from "./userSettings";

// The first protocol whose server keeps command counts (issue 2584).
const COMMAND_COUNTS_PROTOCOL = 61;

// What the menu offers before there is any history, and how equal counts are
// ordered afterwards (vjt's ruling, Q2). The first five are what a fresh
// account sees with the default setting.
export const DEFAULT_COMMAND_ORDER: readonly string[] = [
  "join",
  "msg",
  "me",
  "query",
  "whois",
  "part",
  "nick",
  "away",
  "topic",
  "quit",
];

const serverCountsCommands = (): boolean => {
  const version = serverProtocol();
  return version !== null && version >= COMMAND_COUNTS_PROTOCOL;
};

/**
 * The `limit` verbs among `candidates` that start with `prefix`, in menu
 * order: most counted first; equal counts in the order of the default list,
 * and verbs outside it after the list, alphabetically. With no counts at all
 * that rule IS the default list followed by the alphabet, so "no history yet"
 * needs no branch of its own. A verb named twice is offered once.
 */
export function rankVerbs(
  prefix: string,
  limit: number,
  counts: CommandCounts,
  candidates: readonly string[],
): string[] {
  const wanted = prefix.toLowerCase();
  const countOf = (verb: string): number => atKey(counts, verb) ?? 0;
  const defaultRank = (verb: string): number => {
    const i = DEFAULT_COMMAND_ORDER.indexOf(verb);
    return i === -1 ? DEFAULT_COMMAND_ORDER.length : i;
  };
  return [...new Set(candidates)]
    .filter((verb) => verb.startsWith(wanted))
    .sort(
      (a, b) => countOf(b) - countOf(a) || defaultRank(a) - defaultRank(b) || a.localeCompare(b),
    )
    .slice(0, limit);
}

const exports_ = identityScopedStore((onIdentityChange) => {
  const [commandCounts, setCommandCounts] = createSignal<CommandCounts>(noKeys());

  // Logout / account switch: the counts are the subject's (no event heals a
  // stale mirror); the next account's join hydrates its own.
  onIdentityChange(() => setCommandCounts(noKeys()));

  const refreshCommandCounts = async (): Promise<void> => {
    const t = token();
    if (t === null || !serverCountsCommands()) return;
    setCommandCounts(await getCommandCounts(t));
  };

  // Fire-and-forget: the caller is a send in progress and never waits on this.
  const countCommand = (verb: string): void => {
    const t = token();
    if (t === null || !serverCountsCommands()) return;
    postCommandCount(t, verb).then(setCommandCounts, (err: unknown) =>
      console.warn(`[commandUsage] a count of /${verb} was lost`, err),
    );
  };

  return { commandCounts, refreshCommandCounts, countCommand };
});

export const commandCounts = exports_.commandCounts;
export const refreshCommandCounts = exports_.refreshCommandCounts;
export const countCommand = exports_.countCommand;

/**
 * What the `/` menu shows for `prefix`, and what Tab cycles: every builtin
 * verb and every alias the user defined (an alias that shadows a builtin is
 * one entry, #427), ranked by `rankVerbs` over the mirrored counts.
 */
export const rankCommands = (prefix: string, limit: number): string[] =>
  rankVerbs(prefix, limit, commandCounts(), [
    ...BUILTIN_VERBS,
    ...keyEntries(aliases()).map(([name]) => name),
  ]);

/**
 * issue 2616 — the muted caption under `verb` in the `/` menu. An alias
 * answers with its expansion, and it answers FIRST: #427 lets it shadow a
 * builtin, so when both exist the expansion is what the verb does now. No
 * description at all → null, and the row shows the verb alone.
 */
export const describeCommand = (verb: string): string | null =>
  atKey(aliases(), verb) ?? builtinDescription(verb);
