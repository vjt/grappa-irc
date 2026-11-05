import { assertNever } from "../api";
import { NOW_PLAYING_STALE_MS, nowPlaying, nowPlayingLine } from "../nowPlaying";
import type { CommandHandler } from "./context";

/**
 * #1698 — `/np`: an ACTION naming the track the tuned radio station is
 * playing.
 *
 * THIS VERB WRITES INTO A CHANNEL, which is what makes its refusals the
 * interesting part. Four of its five arms send nothing, and each one refuses
 * for a DIFFERENT observed reason with a different sentence — because the
 * operator's next move differs too (pick a station / stop expecting one from
 * this provider / wait / check the network). A single "nothing to report"
 * would collapse four different repairs into one shrug.
 *
 * WHY IT NEVER SENDS A DEGRADED LINE. The two shapes worth naming, both of
 * which vjt called out as worse than a local error:
 *
 *   * The EMPTY line. `* nick is now playing:  []` is refused three levels
 *     deep — a blank title never becomes a track (`parseSongsFeed`), a
 *     trackless state never becomes a body, and the arms below never reach
 *     the send.
 *   * The STALE line. A track from ten minutes ago published as "now" is a
 *     lie told to other people, so the store stops calling it a track at
 *     three poll intervals and this arm refuses it. Refusing is not this
 *     handler's own rule — it is the same predicate the DISPLAY obeys, so the
 *     rail, the docked bar and the channel can never disagree about whether a
 *     track is current.
 *
 * A station-only fallback ("is listening to Groove Salad") was considered for
 * the trackless arms and rejected: `/np` means "now PLAYING", the operator
 * typed it to name a track, and quietly sending a different sentence is the
 * command deciding it knows better. The station is already one `/me` away for
 * anyone who wants to say that.
 *
 * TARGETING is `ctx.submittedFrom` — the window it was typed in, which is what
 * `/me` does, reached through the same `ctx.sendAction` door `/ctcp <t> ACTION`
 * uses; in an encrypted query that is the peer, so the line goes encrypted, as
 * `/me` there does (issue 2543). No pacing plan: the body is one generated line
 * (112 bytes at the longest of 237 songs measured), so there is no multi-line
 * fan-out to resume.
 */
export const npCommand: CommandHandler<"np"> = async (_cmd, ctx) => {
  const state = nowPlaying();
  switch (state.status) {
    case "idle":
      return { error: "/np: nothing is playing — tune a station from the radio picker first" };
    case "unsupported":
      return { error: `/np: ${state.station} publishes no track information` };
    case "unanswered":
      return { error: `/np: no track from ${state.station} yet — its feed has not answered` };
    case "stale": {
      // The threshold is DERIVED from the store's constant, not retyped: a
      // cadence change must move the sentence with it, or the operator is told
      // a number the code stopped using.
      const minutes = Math.round(NOW_PLAYING_STALE_MS / 60_000);
      return {
        error: `/np: the last track from ${state.station} is over ${minutes} minutes old — not sending it`,
      };
    }
    case "playing":
      await ctx.sendAction(ctx.submittedFrom, nowPlayingLine(state.track, state.station));
      return { ok: true };
    default:
      return assertNever(state);
  }
};
