import { type Component, createEffect, For, Show } from "solid-js";
import BannerSlot from "./BannerSlot";
import {
  activeBanners,
  dismissBanner,
  rearmDismissed,
  sanitizeBanners,
  visibleBanners,
} from "./lib/errorBanners";

// #119 — unified stacked error-banner owner.
//
// Renders every active error source (device connectivity, WS health, bundle
// refresh; #120 will add service-worker-registration failure) as a vertical
// STACK inside ONE `position: fixed; top: 0` flex-column container. The
// children live in NORMAL FLOW inside the fixed container, so N banners stack
// without overlap — the fix for the pre-#119 bug where each banner was its own
// `position: fixed; top: 0` element and they all painted on the same
// coordinate.
//
// State is derived, never owned: `activeBanners()` projects the source signals
// (see `lib/errorBanners.ts`); `sanitizeBanners` enforces the closed-set
// source/severity contract at the render boundary; each entry renders through
// the pure `BannerSlot`. cic never originates banner state.
//
// #207 — the owner also holds the client-local dismiss state (in
// `lib/errorBanners.ts`). Render `visibleBanners()` (active minus dismissed);
// pass each slot an `onDismiss` that hides that source until it recovers. An
// effect calls `rearmDismissed(activeBanners())` whenever the active set
// changes, so a dismissed source that recovers and later re-fires surfaces
// again — a × must never permanently silence a real fault.

const ErrorBanners: Component = () => {
  const banners = (): ReturnType<typeof visibleBanners> => sanitizeBanners(visibleBanners());

  // Re-arm dismissed sources that are no longer active. Kept in an effect (not
  // the render derivation) so the conditional signal write stays out of the
  // tracked <For> scope — rearmDismissed no-ops when nothing changed, so this
  // converges without looping the reactive graph.
  createEffect(() => rearmDismissed(activeBanners()));

  return (
    <Show when={banners().length > 0}>
      {/* <section> with an accessible name is a region landmark — the
          semantic form of role="region" (biome a11y/useSemanticElements). */}
      <section class="error-banners" aria-label="Connection and app status">
        <For each={banners()}>
          {(entry) => <BannerSlot entry={entry} onDismiss={() => dismissBanner(entry.source)} />}
        </For>
      </section>
    </Show>
  );
};

export default ErrorBanners;
