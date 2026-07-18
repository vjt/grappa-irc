import { type Component, createSignal, For, Show } from "solid-js";
import { deleteNotifyNick } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyError } from "./lib/friendlyError";
import { networkIdBySlug } from "./lib/networks";
import { presenceFor, watchByNetwork } from "./lib/notifyWatch";
import NickText from "./NickText";

// #247 — the "Watched" panel: the GUI face of the server-side /notify
// watch list, rendered per network on the home pane. Same authoritative
// list as the /notify command — removal here hits the same REST surface
// and the server broadcasts the updated notify_list back (the panel
// never mutates its own store; cic never originates state).
//
// Deliberately NO add-input: the home pane is input-free by design
// (KISS rule pinned by HomePane.test "does NOT render any compose /
// input affordance") — adding is `/notify add <nick>` from any compose
// box. The panel is the read-and-prune surface.
//
// Dot semantics: ● online / ○ offline / ◌ unknown (no report yet — no
// session, no mechanism, or pre-arm). The store folds lookups with the
// server's rfc1459 key rule (see notifyWatch.ts). Hidden entirely when
// the network has no watch entries.

const dotFor = (state: "online" | "offline" | "unknown"): string => {
  if (state === "online") return "●";
  if (state === "offline") return "○";
  return "◌";
};

const WatchedPanel: Component<{ slug: string }> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  const networkId = () => networkIdBySlug(props.slug);
  const entries = () => {
    const id = networkId();
    return id === undefined ? [] : (watchByNetwork()[id] ?? []);
  };

  const onRemove = async (nick: string) => {
    const t = token();
    if (!t) return;
    setError(null);
    try {
      await deleteNotifyNick(t, props.slug, nick);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Show when={entries().length > 0}>
      <div class="watched-panel" data-testid={`watched-panel-${props.slug}`}>
        <h4 class="watched-panel-title">Watched</h4>
        <ul class="watched-panel-list">
          <For each={entries()}>
            {(entry) => {
              const id = networkId();
              const state = () => (id === undefined ? "unknown" : presenceFor(id, entry.nick));
              return (
                <li class={`watched-panel-item watched-${state()}`}>
                  <span class="watched-panel-dot" data-state={state()}>
                    {dotFor(state())}
                  </span>
                  <NickText nick={entry.nick} extraClass="watched-panel-nick" />
                  <button
                    type="button"
                    class="watched-panel-remove"
                    aria-label={`Stop watching ${entry.nick}`}
                    onClick={() => void onRemove(entry.nick)}
                  >
                    ×
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={error()}>{(msg) => <div class="watched-panel-error">{msg()}</div>}</Show>
      </div>
    </Show>
  );
};

export default WatchedPanel;
