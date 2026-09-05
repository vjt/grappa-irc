import { postTopic } from "../api";
import { channelKey } from "../channelKey";
import { topicByChannel } from "../channelTopic";
import { pushChannelTopicClear } from "../socket";
import { appendTopicShow } from "../topicShow";
import type { CommandHandler } from "./context";

/**
 * #1914 — bare `/topic` or `/topic #chan`: print the topic INTO THE WINDOW,
 * irssi-style, from the cache `channelTopic.ts` already holds.
 *
 * This was a `TODO(C3)` stub that returned an inline ERROR string, so the one
 * verb an operator reaches for to READ the topic answered in red with the name
 * of an unfinished ticket. The topic was never unavailable — the join-time
 * `332`/`333` seed `topicByChannel` on every JOIN and every change — it just
 * had no door into scrollback.
 *
 * The answer lands as an ephemeral row in the SUBMITTING window (see
 * `topicShow.ts` for why the snapshot is frozen and why it is keyed there),
 * NOT as a `{ ok: string }` compose notice: the notice auto-dismisses, and a
 * topic long enough to be unreadable in the TopicBar — the complaint that
 * opened #1914 — is exactly the one a transient green strip cannot carry.
 *
 * An uncached channel is an honest error, never a fabricated empty topic: the
 * cache is dropped on own-PART (#975), so absence means "not in that channel",
 * which `/topic` alone cannot fix. Querying upstream for a channel we are not
 * in would need a server verb — out of scope for a client-only change.
 */
export const topicShowCommand: CommandHandler<"topic-show"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch) return { error: "/topic requires a channel — switch to one or use /topic #chan" };
  const entry = topicByChannel()[channelKey(ctx.networkSlug, ch)];
  if (!entry) return { error: `/topic ${ch} — no topic known; join ${ch} first` };
  appendTopicShow(ctx.key, ch, entry);
  return { ok: true };
};

/**
 * `/topic <text>` or `/topic #chan <text>` — set the topic via REST. An
 * explicit channel wins; otherwise the current channel; otherwise bail.
 */
export const topicSetCommand: CommandHandler<"topic-set"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch)
    return {
      error: "/topic requires a channel — switch to one or use /topic #chan <text>",
    };
  await postTopic(ctx.token, ctx.networkSlug, ch, cmd.text);
  return { ok: true };
};

/** `/topic -delete` or `/topic #chan -delete` — clear the topic via channel event. */
export const topicClearCommand: CommandHandler<"topic-clear"> = async (cmd, ctx) => {
  const ch = cmd.channel ?? ctx.getActiveChannel();
  if (!ch)
    return {
      error: "/topic -delete requires a channel — switch to one or use /topic #chan -delete",
    };
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "topic -delete");
  if (typeof networkId !== "number") return networkId;
  // S21: AWAIT the verb ack (#154 no-silent-drops). A WS-down / server
  // {:error,_} rejects into the dispatcher's shared catch → friendlyChannelError
  // inline alert, instead of painting a green ✓ on a dropped frame.
  await pushChannelTopicClear(networkId, ch);
  return { ok: true };
};
