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

  // #188 — clear-on-away lifecycle. Called from userTopic's away_confirmed
  // handler when a network flips back to "away": drop that network's stale
  // bundle so the NEXT return-from-away consults a fresh panel (the bundle
  // is re-SET via `mentions_bundle` on return). Per-network — sibling
  // networks' bundles are untouched. No-op when the slug has no bundle.
  const clearMentionsBundle = (networkSlug: string): void => {
    setMentionsBundleBySlug((prev) => {
      if (!(networkSlug in prev)) return prev;
      const { [networkSlug]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  return { mentionsBundleBySlug, setMentionsBundle, clearMentionsBundle };
});

export const mentionsBundleBySlug = exports_.mentionsBundleBySlug;
export const setMentionsBundle = exports_.setMentionsBundle;
export const clearMentionsBundle = exports_.clearMentionsBundle;
