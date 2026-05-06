// Effective document visibility — Page Visibility API + window focus tier.
//
// Source-of-truth signal for "is the user actively looking at the cicchetto
// browser tab?" Used by:
//   * subscribe.ts — gates the live-reading cursor advance on incoming msgs.
//     A focused-in-cicchetto window whose browser tab is HIDDEN must NOT
//     auto-advance the cursor; arrivals accumulate as unread.
//   * selection.ts — fires a "leave" advance when the focused window's
//     browser tab loses focus (so reopening it shows the marker).
//
// Why both Page Visibility and window focus/blur:
//   * Page Visibility (`document.visibilityState`) — covers tab switch,
//     window minimize, PWA backgrounded. Misses "user clicked another app
//     on the same desktop without minimizing" — visibility stays "visible"
//     but window keyboard focus is lost.
//   * window focus / blur — fills the gap above. document.hasFocus() is
//     the synchronous accessor; focus/blur events are the trigger.
//
// Mirrors theme.ts's isMobile pattern: createRoot at module load anchors
// the listener; createSignal-backed accessor exported as a Solid getter.
// SSR-cheap defensive boundary kept (cicchetto isn't SSR'd today, but the
// guard costs nothing and matches theme.ts).

import { createEffect, createRoot, createSignal } from "solid-js";

const computeVisible = (): boolean => {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
};

const exports_ = createRoot(() => {
  const [visible, setVisible] = createSignal(computeVisible());

  if (typeof document !== "undefined") {
    const recompute = () => setVisible(computeVisible());
    document.addEventListener("visibilitychange", recompute);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", recompute);
      window.addEventListener("blur", recompute);
    }
    void createEffect(() => {
      // Force the signal into the createRoot's tracking scope (mirrors
      // theme.ts isMobile — keeps Solid's owner happy across HMR reloads).
      void visible();
    });
  }

  return { isDocumentVisible: visible };
});

export const isDocumentVisible = exports_.isDocumentVisible;
