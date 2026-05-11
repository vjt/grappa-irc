import type { Component } from "solid-js";
import { Show } from "solid-js";
import { performRefresh, shouldShowRefreshBanner } from "./lib/bundleHash";

// CP23 S4 B5 — sticky top banner shown when the deployed cic bundle
// hash (server-pushed via `bundle_hash` user-topic event) differs from
// the `bootBundleHash` baked into the page the browser loaded. Click
// reloads the page to pick up the new bundle.
//
// Replaces the manual "operator runs `compose --profile prod run --rm
// cicchetto-build`, then DMs every user a 'hard-refresh please' note"
// stair-step we walked in CP23 S3 (memory
// `feedback_hot_reload_bypasses_cic_bundle.md`).
//
// Auto-dismiss is structural: shouldShowRefreshBanner() is false until
// both hashes are known AND differ; once the user clicks refresh, the
// page reloads and the new bundle's hash matches what the server is
// pushing, so the banner doesn't reappear.

const BundleRefreshBanner: Component = () => {
  return (
    <Show when={shouldShowRefreshBanner()}>
      <div class="bundle-refresh-banner" role="alert">
        <strong>New version available</strong>
        <span>{" — a fresh cicchetto build was deployed. "}</span>
        <button type="button" onClick={performRefresh}>
          Refresh
        </button>
      </div>
    </Show>
  );
};

export default BundleRefreshBanner;
