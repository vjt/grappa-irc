import { banMaskFormValue } from "../banMaskPref";
import { kickban } from "../kickban";
import {
  pushChannelBan,
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelInvite,
  pushChannelKick,
  pushChannelOp,
  pushChannelUnban,
  pushChannelVoice,
  pushRaw,
} from "../socket";
import type { CommandHandler } from "./context";

/**
 * The channel-operator verbs. Every one of them wants the same two
 * resolutions in the same order — the channel first, the network second —
 * and the order is load-bearing: when both would fail the operator must
 * still read the channel error.
 */

export const opCommand: CommandHandler<"op"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("op");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "op");
  if (typeof networkId !== "number") return networkId;
  await pushChannelOp(networkId, chanOrErr, cmd.nicks);
  return { ok: true };
};

export const deopCommand: CommandHandler<"deop"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("deop");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "deop");
  if (typeof networkId !== "number") return networkId;
  await pushChannelDeop(networkId, chanOrErr, cmd.nicks);
  return { ok: true };
};

export const voiceCommand: CommandHandler<"voice"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("voice");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "voice");
  if (typeof networkId !== "number") return networkId;
  await pushChannelVoice(networkId, chanOrErr, cmd.nicks);
  return { ok: true };
};

export const devoiceCommand: CommandHandler<"devoice"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("devoice");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "devoice");
  if (typeof networkId !== "number") return networkId;
  await pushChannelDevoice(networkId, chanOrErr, cmd.nicks);
  return { ok: true };
};

export const kickCommand: CommandHandler<"kick"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("kick");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "kick");
  if (typeof networkId !== "number") return networkId;
  await pushChannelKick(networkId, chanOrErr, cmd.nick, cmd.reason);
  return { ok: true };
};

export const banCommand: CommandHandler<"ban"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("ban");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "ban");
  if (typeof networkId !== "number") return networkId;
  await pushChannelBan(networkId, chanOrErr, cmd.mask);
  return { ok: true };
};

/**
 * #386 — kickban: ban first, in the subject's ban type (issue 2347, default
 * `*!*@host`), then kick, both attempted, fail-closed on an unknown
 * component. The verb is `lib/kickban` (issue 2346), shared with the nick and
 * presence-row menus; `/kb` has no row to read a host off, so it always
 * resolves.
 */
export const kbCommand: CommandHandler<"kb"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("kb");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "kb");
  if (typeof networkId !== "number") return networkId;
  const error = await kickban({
    networkId,
    channel: chanOrErr,
    nick: cmd.nick,
    reason: cmd.reason,
    form: banMaskFormValue(),
    label: "/kb",
  });
  return error === null ? { ok: true } : { error };
};

/**
 * #557 — `/kill <nick> [reason]`: first-class operator KILL. Unlike
 * `/kick`/`/kb` this targets a NICK (no channel, no `requireChannel`) and
 * ships a RAW frame via `pushRaw`, mirroring `/quote` — the server already
 * accepts KILL through the raw passthrough (that is what operators do today
 * with `/quote KILL ...`). The whole win is the trailing colon being composed
 * HERE, downstream: `KILL <nick> :<reason>` keeps a multi-word reason intact
 * instead of the `/quote` foot-gun where a forgotten `:` truncates the reason
 * at its first space. A bare `/kill` (empty reason) sends `KILL <nick>` and
 * lets the server answer (481 for a non-oper, or the ircd's own
 * missing-comment error). AWAIT the push so a WS-down / server `{:error,_}`
 * surfaces as an inline compose alert, never a silent green ✓ (the #154
 * no-silent-drop lesson).
 */
export const killCommand: CommandHandler<"kill"> = async (cmd, ctx) => {
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "kill");
  if (typeof networkId !== "number") return networkId;
  const line = cmd.reason === "" ? `KILL ${cmd.nick}` : `KILL ${cmd.nick} :${cmd.reason}`;
  await pushRaw(networkId, line);
  return { ok: true };
};

export const unbanCommand: CommandHandler<"unban"> = async (cmd, ctx) => {
  const chanOrErr = ctx.requireChannel("unban");
  if (typeof chanOrErr !== "string") return chanOrErr;
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "unban");
  if (typeof networkId !== "number") return networkId;
  await pushChannelUnban(networkId, chanOrErr, cmd.mask);
  return { ok: true };
};

/**
 * `/invite <nick> [#chan]` — channel defaults to the active window.
 *
 * P-0f follow-up (no-silent-drops bucket 0): when the channel arg is supplied
 * explicitly, SKIP `requireChannel` — typing `/invite foo #it-opers` from
 * $server (or any non-channel window) was the common workflow that pre-fix
 * silently errored ("requires an active channel window") because
 * `requireChannel` was unconditionally evaluated.
 */
export const inviteCommand: CommandHandler<"invite"> = async (cmd, ctx) => {
  let chan: string;
  if (cmd.channel !== null) {
    chan = cmd.channel;
  } else {
    const chanOrErr = ctx.requireChannel("invite");
    if (typeof chanOrErr !== "string") return chanOrErr;
    chan = chanOrErr;
  }
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "invite");
  if (typeof networkId !== "number") return networkId;
  // S6 (#364): await the verb-ack so a server {:error,_} / WS-down surfaces
  // inline (shared catch → friendlyChannelError), not a false green ✓.
  // Mirror of kick/ban.
  await pushChannelInvite(networkId, chan, cmd.nick);
  return { ok: true };
};
