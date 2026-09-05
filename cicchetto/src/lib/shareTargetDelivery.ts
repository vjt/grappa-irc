import { createEffect, untrack } from "solid-js";
import { dropUpload } from "./dropUpload";
import { casemappingForNetwork } from "./isupport";
import { loadLastFocused } from "./lastFocusedChannel";
import { moduleRoot } from "./moduleRoot";
import { channelsBySlug, networkBySlug, user } from "./networks";
import { nickEquals } from "./nickEquals";
import { queryWindowsByNetwork } from "./queryWindows";
import { SHARE_TARGET_PARAM, takeSharedFiles } from "./shareTarget";
import { recordShareTargetBlock, type ShareTargetBlock } from "./shareTargetOutcome";
import { categoryOf } from "./uploadCategory";

// #1103 — the app half of Web Share Target: pick up the files the service
// worker stashed, decide where they go, and hand them to the upload path that
// already exists.
//
// ## The destination is THE open question, so it is one function
//
// A share arrives with no window selected — the operator was in another app.
// Whether cicchetto should deliver to the window they were last in or ask
// them with a picker is a product decision that has not been made. So the
// whole policy is `resolveShareDestination` below and nothing else knows how
// a destination is chosen: settling the question later replaces that one
// function instead of touching the service worker, the boot path and the
// delivery in three places.
//
// PROVISIONAL, pending that decision: deliver to the last focused window.
// That reading is defensible on its own terms — the share came from OUTSIDE
// the app, so there is no window on screen to mean anything by "here", and
// the window the operator last used is the only place they have expressed an
// interest in. It is not a claim that the picker would be wrong.
//
// ## Why the LAST FOCUSED window and not the live selection
//
// A share POST is answered with a redirect, so the SPA boots cold: at the
// moment this reader runs, `selectedChannel()` is null, and Shell's cold-load
// arm may land `$home` PROVISIONALLY before the saved window arrives
// (Shell.tsx, #187) — a reader watching the live signal would see that home
// and conclude "nowhere to deliver" for an operator who has a perfectly good
// channel. `loadLastFocused` is the same record Shell restores FROM, is
// written by the selection store on every focus change, and is readable the
// instant `/me` resolves. No race to lose.
//
// It is still checked against the live stores before use, because the answer
// to "can a file be sent here" is not the answer to "can this window be
// focused": a channel parted while cic was closed still restores fine as a
// selection but would swallow the upload URL.
//
// ## No new upload plumbing
//
// The files go through `dropUpload`, the same entry point drag-and-drop
// (DropUploadZone) and clipboard paste (pasteRoute) use, which owns the
// category filter, the privacy modal, the queue and the sequential pump.

export type ShareDestination = { networkSlug: string; channelName: string };

/**
 * What the destination policy is allowed to look at. Injected rather than
 * imported so the policy is a pure function of what the stores say — the
 * same seam shape as `installStaleResumeReload`.
 */
export type ShareDestinationSources = {
  /** The persisted last-focused window for the current identity. */
  lastFocused: () => ReturnType<typeof loadLastFocused>;
  /** Is this channel currently joined? */
  channelExists: (networkSlug: string, channelName: string) => boolean;
  /** Is a query window open with this peer? */
  queryExists: (networkSlug: string, nick: string) => boolean;
};

export type ShareDeliveryPlan =
  | { kind: "deliver"; destination: ShareDestination; files: File[] }
  | { kind: "blocked"; reason: ShareTargetBlock };

/**
 * THE destination policy. Change this one function to change where a shared
 * file lands; nothing else in the feature encodes the answer.
 *
 * Returns null when there is no window a file can be sent to. Only `channel`
 * and `query` qualify: every other kind — including `server`, which has real
 * scrollback and so looks like a candidate — has no IRC target to carry the
 * upload URL.
 */
export function resolveShareDestination(sources: ShareDestinationSources): ShareDestination | null {
  const saved = sources.lastFocused();
  if (saved === null) return null;
  if (saved.kind === "channel") {
    return sources.channelExists(saved.networkSlug, saved.channelName)
      ? { networkSlug: saved.networkSlug, channelName: saved.channelName }
      : null;
  }
  if (saved.kind === "query") {
    return sources.queryExists(saved.networkSlug, saved.channelName)
      ? { networkSlug: saved.networkSlug, channelName: saved.channelName }
      : null;
  }
  return null;
}

/**
 * Decide what to do with a share: deliver it, or name the reason it cannot be
 * delivered. Pure — the caller performs whichever the plan says.
 *
 * The destination is checked FIRST. When both are wrong the operator hears
 * about the window, because that is the one they can act on.
 *
 * The file filter is `categoryOf`, the same gate drag-and-drop and paste
 * apply, so this door cannot develop its own idea of what is uploadable.
 */
export function shareDeliveryPlan(
  files: readonly File[],
  sources: ShareDestinationSources,
): ShareDeliveryPlan {
  const destination = resolveShareDestination(sources);
  if (destination === null) return { kind: "blocked", reason: "no-destination" };
  const uploadable = files.filter((f) => categoryOf(f.type) !== null);
  if (uploadable.length === 0) return { kind: "blocked", reason: "nothing-uploadable" };
  return { kind: "deliver", destination, files: uploadable };
}

/**
 * Boot entry: if this document was opened by a share, collect the files and
 * act on the plan.
 *
 * NOT unit-tested, and it cannot usefully be: it reads `location`, the Cache
 * API and three live resources. The decision it defers to IS tested; what is
 * left here is the wiring, and the browser is the only thing that can
 * exercise it.
 *
 * Deferred until `/me` and the channel list resolve, for the same reason
 * `applyDeepLinkFromUrl` defers: the policy reads stores, and an unresolved
 * store answers "no" to every question.
 */
export function applySharedFilesFromUrl(): void {
  if (typeof window === "undefined" || !window.location) return;
  if (new URL(window.location.href).searchParams.get(SHARE_TARGET_PARAM) === null) return;
  if (typeof caches === "undefined") {
    console.warn("[shareTarget] share landing reached without a Cache API");
    return;
  }

  let applied = false;
  moduleRoot(() => {
    createEffect(() => {
      if (applied) return;
      // Falsy, not `=== undefined`: the resource reads `undefined` while it
      // loads and `null` when it resolved to no session. Neither can answer
      // "which window was this identity last in".
      const me = user();
      if (!me) return;
      if (channelsBySlug() === undefined) return;
      applied = true;
      untrack(() => void consumeShare(me.id));
    });
  });
}

async function consumeShare(userId: string): Promise<void> {
  const files = await takeSharedFiles(caches);
  const plan = shareDeliveryPlan(files, liveSources(userId));
  if (plan.kind === "blocked") {
    console.warn("[shareTarget] share not delivered:", plan.reason);
    recordShareTargetBlock(plan.reason);
  } else {
    // #1883 — the share is the ONE upload door with no gesture left on screen,
    // so a confirm displaced before the operator answers it loses the files
    // silently. Report it as a block like any other undelivered share; the
    // banner is the only thing that can tell them to share again.
    dropUpload(plan.files, plan.destination.networkSlug, plan.destination.channelName, () =>
      recordShareTargetBlock("confirm-displaced"),
    );
  }
  // Drop the flag either way: a reload must not re-run a share whose files
  // have already been consumed.
  if (window.history && window.location) {
    window.history.replaceState({}, "", "/");
  }
}

function liveSources(userId: string): ShareDestinationSources {
  return {
    lastFocused: () => loadLastFocused(userId),
    channelExists: (slug, name) => (channelsBySlug()?.[slug] ?? []).some((c) => c.name === name),
    queryExists: (slug, nick) => {
      const net = networkBySlug(slug);
      if (net === undefined) return false;
      return (queryWindowsByNetwork()[net.id] ?? []).some((q) =>
        nickEquals(q.targetNick, nick, casemappingForNetwork(net.id)),
      );
    },
  };
}
