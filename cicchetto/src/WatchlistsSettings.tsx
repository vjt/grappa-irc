import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { deleteNotifyNick, type Network, postNotifyAdd } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyError } from "./lib/friendlyError";
import {
  addHighlight,
  delHighlight,
  highlightPatterns,
  refreshHighlights,
} from "./lib/highlightList";
import { networks } from "./lib/networks";
import { presenceFor, watchByNetwork } from "./lib/notifyWatch";
import NickText from "./NickText";

// #356 — the unified "watch lists" settings SUB-PAGE. ONE section header
// holding BOTH lists:
//   * presence / notify (PER NETWORK) — the list formerly on the home page
//     as "Watched", MOVED here. Same authoritative per-network state
//     (watchByNetwork / presenceFor / postNotifyAdd / deleteNotifyNick), NOT
//     a copy — cic never originates state; removal here hits the same REST
//     surface the server broadcasts back.
//   * keyword / highlight — brand new. Backed by the highlightList store
//     (server user_settings, no broadcast; refreshed on open, add/del mirror
//     the {patterns} response). Add via /hilight, prune via × here.
//
// Self-contained (reads the module stores directly, like WatchedPanel) — no
// props threaded through the drawer; the only prop is the sub-page ‹ back.

const dotFor = (state: "online" | "offline" | "unknown"): string => {
  if (state === "online") return "●";
  if (state === "offline") return "○";
  return "◌";
};

// One network's presence block: its watched nicks (dot + × remove) + an
// add-input scoped to that network (presence is per-network).
const PresenceNetworkBlock: Component<{ net: Network }> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const entries = () => watchByNetwork()[props.net.id] ?? [];

  const onAdd = async (e: Event) => {
    e.preventDefault();
    const t = token();
    const nick = draft().trim();
    if (!t || nick === "" || busy()) return;
    setError(null);
    setBusy(true);
    try {
      await postNotifyAdd(t, props.net.slug, [nick]);
      setDraft("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (nick: string) => {
    const t = token();
    if (!t) return;
    setError(null);
    try {
      await deleteNotifyNick(t, props.net.slug, nick);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <div class="watchlists-network" data-testid={`watchlists-notify-${props.net.slug}`}>
      <h5 class="watchlists-network-slug">{props.net.slug}</h5>
      <ul class="watchlists-list">
        <For each={entries()}>
          {(entry) => {
            const state = () => presenceFor(props.net.id, entry.nick);
            return (
              <li class="watchlists-item">
                <span class="watchlists-dot" data-state={state()}>
                  {dotFor(state())}
                </span>
                <NickText nick={entry.nick} extraClass="watchlists-nick" />
                <button
                  type="button"
                  class="watchlists-remove"
                  aria-label={`Stop watching ${entry.nick} on ${props.net.slug}`}
                  onClick={() => void onRemove(entry.nick)}
                >
                  ×
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <form class="watchlists-add" onSubmit={(e) => void onAdd(e)}>
        <input
          type="text"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          placeholder="add a nick to watch"
          value={draft()}
          data-testid={`watchlists-notify-add-${props.net.slug}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class="watchlists-add-btn" disabled={busy()}>
          add
        </button>
      </form>
      <Show when={error()}>{(msg) => <p class="watchlists-error">{msg()}</p>}</Show>
    </div>
  );
};

const WatchlistsSettings: Component<{ onBack: () => void }> = (props) => {
  const [kwDraft, setKwDraft] = createSignal("");
  const [kwError, setKwError] = createSignal<string | null>(null);
  const [kwBusy, setKwBusy] = createSignal(false);

  // Keyword list has no server broadcast — refresh the store on open so the
  // section reflects the current server user_settings.
  onMount(() => {
    void refreshHighlights().catch((err) => setKwError(friendlyError(err)));
  });

  const onAddKeyword = async (e: Event) => {
    e.preventDefault();
    const pattern = kwDraft().trim();
    if (pattern === "" || kwBusy()) return;
    setKwError(null);
    setKwBusy(true);
    try {
      await addHighlight(pattern);
      setKwDraft("");
    } catch (err) {
      setKwError(friendlyError(err));
    } finally {
      setKwBusy(false);
    }
  };

  const onRemoveKeyword = async (pattern: string) => {
    setKwError(null);
    try {
      await delHighlight(pattern);
    } catch (err) {
      setKwError(friendlyError(err));
    }
  };

  return (
    <section class="settings-subpage watchlists-subpage" data-testid="watchlists-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="watchlists-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>watch lists</h3>
      </header>

      {/* Presence / notify — per network. */}
      <div class="settings-section" data-testid="watchlists-section-notify">
        <h4 class="settings-section-heading">presence (notify)</h4>
        <p class="settings-section-blurb">
          watch nicks for online/offline — a dot lights up when they join.
        </p>
        <Show
          when={(networks() ?? []).length > 0}
          fallback={<p class="watchlists-empty">no networks yet.</p>}
        >
          <For each={networks() ?? []}>{(net) => <PresenceNetworkBlock net={net} />}</For>
        </Show>
      </div>

      {/* Keyword / highlight — one user-wide list. */}
      <div class="settings-section" data-testid="watchlists-section-highlight">
        <h4 class="settings-section-heading">highlight keywords</h4>
        <p class="settings-section-blurb">
          get notified when a message contains one of these words.
        </p>
        <ul class="watchlists-list" data-testid="watchlists-highlight-list">
          <For each={highlightPatterns()}>
            {(pattern) => (
              <li class="watchlists-item">
                <span class="watchlists-keyword">{pattern}</span>
                <button
                  type="button"
                  class="watchlists-remove"
                  aria-label={`Remove highlight ${pattern}`}
                  onClick={() => void onRemoveKeyword(pattern)}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
        <form class="watchlists-add" onSubmit={(e) => void onAddKeyword(e)}>
          <input
            type="text"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="add a highlight word"
            value={kwDraft()}
            data-testid="watchlists-highlight-add"
            onInput={(e) => setKwDraft(e.currentTarget.value)}
          />
          <button type="submit" class="watchlists-add-btn" disabled={kwBusy()}>
            add
          </button>
        </form>
        <Show when={kwError()}>{(msg) => <p class="watchlists-error">{msg()}</p>}</Show>
      </div>
    </section>
  );
};

export default WatchlistsSettings;
