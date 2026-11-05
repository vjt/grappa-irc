import type { ChannelKey } from "../channelKey";
import type { SlashCommand } from "../slashCommands";

// #1396 — the dispatch vocabulary, lifted out of `compose.ts` so a command
// handler can live outside the store module. `compose.ts` keeps the store and
// the send pipeline; what moves here is the part that only ever needed a few
// named values.
//
// The record is deliberately NARROW. Of the 87 identifiers the 59-arm switch
// calls, 69 are ordinary module imports a handler can import for itself and 4
// are `compose.ts` top-level consts; only the values below cannot be reached
// that way, because they close over the submitting window. Anything a handler
// can import, it imports — the context carries what is per-submission, not
// what is merely convenient.
export type SubmitResult = { ok: true | string } | { error: string };

// The pump owns the composer buffer and hands the text back on failure, so a
// handler that manages its own residue says so with `keptBuffer`.
export type DispatchOutcome = SubmitResult | { error: string; keptBuffer: true };

export type CommandContext = {
  /** The submitting window. */
  key: ChannelKey;
  networkSlug: string;
  /**
   * The submitting window's name, as spelled. Named for the FACT it carries
   * and not for any use of it, because the uses disagree: `part` reads it as
   * a default TARGET and the three relay verbs as the WINDOW their echo lands
   * in. A name like `channelName` reads as "the channel" and invites those
   * two to be flattened into one pre-resolved value; this one cannot.
   *
   * Not derivable from `key`: `channelKey` folds the name (#537), so the
   * spelling survives only here — and `part` puts it on the WIRE.
   *
   * issue 2536 — the one place the two fields name different windows: for a
   * command typed in an encrypted query, `key` stays that window (an answer
   * shown in the window, `/ignore`'s or `/topic`'s, lands where it was asked)
   * while this is the peer's nick, the plain query the command runs in, as it
   * would there. Never `$e2e:<nick>`, a window grappa has never heard of.
   */
  submittedFrom: string;
  /** The raw draft, before parsing — the one arm that re-reads it needs it. */
  text: string;
  /** The session bearer, already proven present by the dispatcher. */
  token: string;
  /**
   * The ACTIVE window's channel, or null when the active window is not a
   * channel. Distinct from `submittedFrom`: a submit can be queued across a
   * window switch, so the two can disagree. This is the one the arms behind
   * `requireChannel` want — NOT the one a target defaults to (`part` defaults
   * to `submittedFrom`, and a test now pins that).
   */
  getActiveChannel: () => string | null;
  /**
   * The channel sigils THIS network advertised (005 CHANTYPES). Per-submission
   * because it is keyed on the submitting window's network; the resolver
   * behind it also answers for other slugs, which is why it stays in
   * `compose.ts` rather than becoming an import a handler could reach.
   *
   * A THUNK, not a value, and the characterization net is why: resolving it
   * when the record is built puts a `networkIdBySlug` on EVERY submission,
   * including the 58 arms that never ask. That is the same eager-resolution
   * trap `requireNetworkId` documents, and the net caught it.
   */
  sigils: () => readonly string[];
  /**
   * Require a channel window, or the inline error the operator reads.
   * Thirteen arms call it FIRST, before resolving a network: when both would
   * fail the operator must still see the channel error, so the call ORDER is
   * part of the contract, not an accident of layout.
   */
  requireChannel: (verb: string) => string | { error: string };
  /**
   * The network twin: a SLUG resolves to the live network id, or to the
   * inline error. Called FROM the handler rather than resolved once up front,
   * which keeps it LAZY (14 arms never ask — the REST verbs address the
   * network by slug) and keeps the slug a PARAMETER (two arms resolve one
   * other than `networkSlug`).
   */
  requireNetworkId: (slug: string, subject: string) => number | { error: string };
  /**
   * The NICK twin of `requireChannel`, for the arms that take a bare nick:
   * a query window resolves to the partner, every other network-scoped window
   * to the operator's own nick on this network. Lives on the record for the
   * same reason its two siblings do — it closes over the selected window.
   */
  resolveBareWhoisNick: (verb: string) => string | { error: string };
  /**
   * issue 2543 — send an ACTION saying `text` to `target`. The one door for
   * every command that sends an ACTION (`/np`, `/ctcp <t> ACTION`), because
   * whether it may go in clear depends on the window it was typed in: aimed at
   * the peer of the encrypted query it was typed in, it is what `/me` is
   * there, one message inside Olm; anywhere else it is the clear CTCP ACTION.
   * (`/me` itself stays the dispatcher's, with its paced fan-out.) A new
   * caller extends `actsToPeer` in `compose.ts` too: the paste guard asks that
   * same question before the submit, and a guard that answers "no" for an
   * encrypted send offers the text file that puts the block on the upload
   * host in clear.
   */
  sendAction: (target: string, text: string) => Promise<void>;
};

/**
 * A handler for one verb. Returns what the arm returned: the dispatcher
 * neither inspects nor re-wraps it.
 */
export type CommandHandler<K extends SlashCommand["kind"]> = (
  cmd: Extract<SlashCommand, { kind: K }>,
  ctx: CommandContext,
) => Promise<DispatchOutcome>;
