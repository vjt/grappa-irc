import { createRoot, createSignal, on } from "solid-js";
import type { MentionsBundle } from "../MentionsWindow";
import { token } from "./auth";

// Mentions-bundle store. Holds one MentionsBundle per network slug,
// populated by the `mentions_bundle` push event on the user-level
// Phoenix Channel topic (sent by Session.Server.unset_away_internal/2
// when back-from-away with matching watchlist messages).
//
// The bundle is ephemeral — it represents the "you just came back from
// away, here's what you missed" snapshot. Shell renders a MentionsWindow
// pane when the selection kind === "mentions". The bundle persists in this
// signal until replaced by the next away cycle or until logout.
//
// Identity-scoped: on logout / token rotation, all bundles are cleared.

const exports_ = createRoot(() => {
  const [mentionsBundleBySlug, setMentionsBundleBySlug] = createSignal<
    Record<string, MentionsBundle>
  >({});

  // Clear on identity change (logout or token rotation).
  on(token, (t, prev) => {
    if (prev != null && t !== prev) setMentionsBundleBySlug({});
  });

  const setMentionsBundle = (networkSlug: string, bundle: MentionsBundle): void => {
    setMentionsBundleBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  return { mentionsBundleBySlug, setMentionsBundle };
});

export const mentionsBundleBySlug = exports_.mentionsBundleBySlug;
export const setMentionsBundle = exports_.setMentionsBundle;
