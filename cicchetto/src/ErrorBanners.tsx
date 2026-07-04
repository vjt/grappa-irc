import { type Component, For, Show } from "solid-js";
import BannerSlot from "./BannerSlot";
import { activeBanners, sanitizeBanners } from "./lib/errorBanners";

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

const ErrorBanners: Component = () => {
  const banners = (): ReturnType<typeof activeBanners> => sanitizeBanners(activeBanners());
  return (
    <Show when={banners().length > 0}>
      {/* <section> with an accessible name is a region landmark — the
          semantic form of role="region" (biome a11y/useSemanticElements). */}
      <section class="error-banners" aria-label="Connection and app status">
        <For each={banners()}>{(entry) => <BannerSlot entry={entry} />}</For>
      </section>
    </Show>
  );
};

export default ErrorBanners;
