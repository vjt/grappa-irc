import { createSignal } from "solid-js";
import type { MentionsBundle } from "../MentionsWindow";
import { identityScopedStore } from "./identityScopedStore";

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
// Identity-scoped: on logout / token rotation, all bundles are cleared via
// `identityScopedStore`'s registered reset (dup-A3 close).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [mentionsBundleBySlug, setMentionsBundleBySlug] = createSignal<
    Record<string, MentionsBundle>
  >({});

  onIdentityChange(() => setMentionsBundleBySlug({}));

  const setMentionsBundle = (networkSlug: string, bundle: MentionsBundle): void => {
    setMentionsBundleBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  return { mentionsBundleBySlug, setMentionsBundle };
});

export const mentionsBundleBySlug = exports_.mentionsBundleBySlug;
export const setMentionsBundle = exports_.setMentionsBundle;
