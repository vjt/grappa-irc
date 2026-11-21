import { patchNetwork } from "../api";
import { ApiError } from "../apiError";
import { bounceNetwork } from "../reconnect";
import type { CommandHandler } from "./context";

/**
 * `/connect <network>` — unpark + respawn. Network slug guaranteed by the
 * parser (bare `/connect` surfaces as `kind: "error"` instead).
 */
export const connectCommand: CommandHandler<"connect"> = async (cmd, ctx) => {
  await patchNetwork(ctx.token, cmd.network, { connection_state: "connected" });
  return { ok: true };
};

/**
 * #1796 — `/reconnect [network] [reason]`: bounce ONE network, park then
 * unpark. Bare form resolves the active window's network, symmetric with
 * `/disconnect`, so the two verbs an operator alternates between read their
 * arguments the same way.
 *
 * The bounce itself is `lib/reconnect.ts`'s `bounceNetwork` — the same two-leg
 * PATCH #282's vhost button drives, extracted rather than re-typed. That is
 * also where the sequential ordering is decided and argued.
 *
 * NO confirmation modal, and that is #283 (2026-07-20) on record rather than
 * an omission: DISCONNECT is the verb behind the #195 confirm, RECONNECT is
 * the awaited PATCH, because it is trivially reversible. The error sink is the
 * compose feedback seam (the shared catch in `compose.ts`), not a new alert.
 *
 * `not_connected` is re-copy'd rather than left to `friendlyApiError`: the
 * shared line ("isn't in a state to connect or disconnect right now") is true
 * of `/connect` and `/disconnect` but wrong here — a parked network IS in a
 * state to connect, and the operator can act on being told so. Still an
 * `{error}`: this does not silently fall through to the unpark leg, because
 * "bounce" and "bring up" are different intentions and only the operator can
 * say which one they meant.
 */
export const reconnectCommand: CommandHandler<"reconnect"> = async (cmd, ctx) => {
  const targetSlug = cmd.network ?? ctx.networkSlug;
  try {
    await bounceNetwork(ctx.token, targetSlug, cmd.reason);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_connected") {
      return { error: `/reconnect: ${targetSlug} is not connected — use /connect ${targetSlug}` };
    }
    throw e;
  }
  return { ok: true };
};
