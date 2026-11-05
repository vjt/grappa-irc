import { sendCtcpQuery } from "../ctcpQuery";
import { sendMessage as sendWindowMessage } from "../scrollback";
import type { SlashCommand } from "../slashCommands";
import type { CommandHandler } from "./context";

/**
 * The verbs that address someone who is NOT this window, while the echo stays
 * here.
 *
 * #1396 — all three read `ctx.submittedFrom`, and all three mean the same
 * thing by it: the window the echo lands in, NOT the recipient. That is a
 * different meaning from `part`'s (where the same fact is the default TARGET),
 * which is why the record hands over the submitting window as ONE raw fact,
 * named for the fact, and lets each handler say what it is for.
 */

/**
 * Whether a `/ctcp` is an ACTION, the one CTCP that is conversation. The parser
 * upper-cases the verb; asked case-insensitively regardless.
 */
export const isActionCtcp = (cmd: Extract<SlashCommand, { kind: "ctcp" }>): boolean =>
  cmd.verb.toUpperCase() === "ACTION";

/**
 * #591 — `/ctcp <target> <VERB> [args]`: a single CTCP frame to an EXPLICIT
 * target (not the current window). Non-ACTION CTCP is single-line by convention
 * (Grappa.IRC.LineSplit) so there is no multiline fan-out. AWAIT the send: a
 * CTCP verb MUST NOT silently no-op when the WS is down.
 */
export const ctcpCommand: CommandHandler<"ctcp"> = async (cmd, ctx) => {
  // ACTION is the exception this door keeps for itself: it IS conversation
  // (`/me` to an explicit target), so it belongs in the TARGET window and rides
  // the normal send path (the server also rejects an ACTION through the CTCP
  // route — `Session.send_ctcp`'s non-ACTION gate). issue 2543 — through
  // `sendAction`, so an ACTION to the peer of the encrypted query it was typed
  // in goes encrypted, as `/me` there does.
  if (isActionCtcp(cmd)) {
    await ctx.sendAction(cmd.target, cmd.args);
    return { ok: true };
  }
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "ctcp");
  if (typeof networkId !== "number") return networkId;
  // Everything else is a control-surface probe and goes through the #1192 seam,
  // which owns the #640 source-window echo and the #600 register-before-send
  // ordering.
  //
  // Consequence worth naming: `/ctcp <t> PING` CORRELATES, where it used to
  // drop its reply into `$server` as an uncorrelated "← CTCP PING reply from …"
  // row. The verb was always a ping; only the sugar knew to correlate it.
  // Nothing changes on the WIRE — the seam mints no token, so a bare
  // `/ctcp bob PING` still frames `\x01PING\x01` and rides the #637 token-less
  // fallback home.
  await sendCtcpQuery({
    networkSlug: ctx.networkSlug,
    networkId,
    sourceChannel: ctx.submittedFrom,
    targetNick: cmd.target,
    verb: cmd.verb,
    args: cmd.args,
    sentAtMs: Date.now(),
  });
  return { ok: true };
};

/**
 * #591 — `/ping <target>`: CTCP PING sugar over the same seam. The token is a
 * client timestamp; it travels in the frame, comes back verbatim in the reply's
 * server-typed meta.ctcp_args, and the RTT is `now - sentAt` (synthesized in
 * subscribe.ts, irssi behavior). Minting the token is ALL this sugar adds — the
 * correlation bookkeeping and its ordering belong to the seam, and did not
 * survive being held by hand once a third caller appeared.
 */
export const pingCommand: CommandHandler<"ping"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "ping");
  if (typeof networkId !== "number") return networkId;
  const sentAtMs = Date.now();
  await sendCtcpQuery({
    networkSlug: ctx.networkSlug,
    networkId,
    sourceChannel: ctx.submittedFrom,
    targetNick: cmd.target,
    verb: "PING",
    args: String(sentAtMs),
    sentAtMs,
  });
  return { ok: true };
};

/**
 * #1225 — `/notice <target> <text>`. Routed like a CTCP query, not like /msg:
 * the echo persists in the window it was TYPED in (`ctx.submittedFrom`) and no
 * window is opened for the recipient, because a NOTICE opens none by convention
 * (RFC 2812 §3.3.2 — it is the verb you must not reply to) and every client the
 * operators come from echoes it where they are looking. That is also why a
 * CHANNEL recipient is fine here while /msg refuses one: /msg's refusal exists
 * to stop a phantom query window, and this path opens no window at all.
 *
 * Single await, no #666 pacing plan: a slash command is one line, so there is
 * no multi-send to pace. A throttled send surfaces its 429 the same way a lone
 * /msg does.
 */
export const noticeCommand: CommandHandler<"notice"> = async (cmd, ctx) => {
  await sendWindowMessage(ctx.networkSlug, ctx.submittedFrom, cmd.body, {
    kind: "notice",
    target: cmd.target,
  });
  return { ok: true };
};
