import { createEffect, createRoot, createSignal, on } from "solid-js";
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
//
// Codebase review 2026-05-08 cic H1: cleanup arm MUST be wrapped in
// `createEffect(on(token, …))`. Pre-fix the bare `on(...)` combinator
// was never registered with the reactive system; rotation cleanup never
// fired and the prior tenant's mentions bundle leaked into the new
// session's view. Mirrors the scrollback.ts / members.ts pattern.

const exports_ = createRoot(() => {
  const [mentionsBundleBySlug, setMentionsBundleBySlug] = createSignal<
    Record<string, MentionsBundle>
  >({});

  // Clear on identity change (logout or token rotation).
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) setMentionsBundleBySlug({});
    }),
  );

  const setMentionsBundle = (networkSlug: string, bundle: MentionsBundle): void => {
    setMentionsBundleBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  return { mentionsBundleBySlug, setMentionsBundle };
});

export const mentionsBundleBySlug = exports_.mentionsBundleBySlug;
export const setMentionsBundle = exports_.setMentionsBundle;
