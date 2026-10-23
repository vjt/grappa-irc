import { type Component, For, Show } from "solid-js";
import type { NetworkResult } from "./lib/e2e/pairingSession";

// issue 2430, X1-crypto — what a pairing came to on each network, one line
// each. Both screens (AddDevicePanel, PairScan) show the same results in the
// same words, so the words live here once.

const OUTCOME: Record<NetworkResult["outcome"], string> = {
  added: "added",
  full: "already has 4 devices",
  paired: "already paired",
  "list-changed": "the list changed, try again",
  failed: "failed",
};

const PairResults: Component<{ results: NetworkResult[] }> = (props) => (
  <Show when={props.results.length > 0}>
    <ul class="pair-results">
      <For each={props.results}>
        {(r) => (
          <li data-testid={`pair-result-${r.network}`}>
            {r.network}: {OUTCOME[r.outcome]}
          </li>
        )}
      </For>
    </ul>
  </Show>
);

export default PairResults;
