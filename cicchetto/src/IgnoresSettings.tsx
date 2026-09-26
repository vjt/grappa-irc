import { type Component, createSignal, For, onMount, Show } from "solid-js";
import type { IgnoreEntry, Network } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyError } from "./lib/friendlyError";
import { addIgnore, delIgnore, ignoresBySlug, refreshIgnores } from "./lib/ignoreList";
import { networks } from "./lib/networks";

// #162 — the ignore-list settings SUB-PAGE. One block per network (the list
// is per network, like presence notify): the masks with a × to remove, and
// an add-input scoped to that network. Same authoritative state the
// `/ignore` verbs use (`ignoreList.ts` mirrors every REST answer) — cic never
// originates state; a × here hits the same DELETE the `/unignore` verb does.
//
// Shaped after `WatchlistsSettings` (#356) on purpose, down to the list
// classes: an operator who has pruned a watch list should not have to learn
// a second look for pruning an ignore list.
//
// issue 2294 — an entry is a PAIR (mask + optional text glob), so the row
// renders both and the × removes the PAIR. The add form grew a second,
// optional input rather than asking the operator to type one field with a
// separator: the verb `/ignore <mask> <pattern>` already has the space as
// its separator, and a form has no line to split.

// The one spelling of an entry in operator-facing text — the settings row
// and the `/ignore` verb row must not describe the same rule two ways.
const describeEntry = (entry: IgnoreEntry): string =>
  entry.text_pattern === null ? entry.mask : `${entry.mask} matching ${entry.text_pattern}`;

const IgnoreNetworkBlock: Component<{ net: Network }> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [patternDraft, setPatternDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const entries = () => ignoresBySlug()[props.net.slug] ?? [];

  // No broadcast for this list — fetch on open so the block shows the
  // server's current masks, not a stale mirror from an earlier session.
  onMount(() => {
    const t = token();
    if (!t) return;
    void refreshIgnores(t, props.net.slug).catch((err) => setError(friendlyError(err)));
  });

  const onAdd = async (e: Event) => {
    e.preventDefault();
    const t = token();
    const mask = draft().trim();
    const pattern = patternDraft().trim();
    if (!t || mask === "" || busy()) return;
    setError(null);
    setBusy(true);
    try {
      await addIgnore(t, props.net.slug, mask, pattern === "" ? null : pattern);
      setDraft("");
      setPatternDraft("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (entry: IgnoreEntry) => {
    const t = token();
    if (!t) return;
    setError(null);
    try {
      await delIgnore(t, props.net.slug, entry.mask, entry.text_pattern);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <div class="watchlists-network" data-testid={`ignores-network-${props.net.slug}`}>
      <h5 class="watchlists-network-slug">{props.net.slug}</h5>
      <Show
        when={entries().length > 0}
        fallback={<p class="watchlists-empty">nothing ignored on {props.net.slug}.</p>}
      >
        <ul class="watchlists-list" data-testid={`ignores-list-${props.net.slug}`}>
          <For each={entries()}>
            {(entry) => (
              <li class="watchlists-item">
                <span class="watchlists-keyword">{describeEntry(entry)}</span>
                <button
                  type="button"
                  class="watchlists-remove"
                  aria-label={`Stop ignoring ${describeEntry(entry)} on ${props.net.slug}`}
                  onClick={() => void onRemove(entry)}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form class="watchlists-add" onSubmit={(e) => void onAdd(e)}>
        <input
          type="text"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          placeholder="add a nick or nick!user@host"
          value={draft()}
          data-testid={`ignores-add-${props.net.slug}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <input
          type="text"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          placeholder="text pattern (optional)"
          value={patternDraft()}
          data-testid={`ignores-add-pattern-${props.net.slug}`}
          onInput={(e) => setPatternDraft(e.currentTarget.value)}
        />
        <button type="submit" class="watchlists-add-btn" disabled={busy()}>
          add
        </button>
      </form>
      <Show when={error()}>{(msg) => <p class="watchlists-error">{msg()}</p>}</Show>
    </div>
  );
};

const IgnoresSettings: Component<{ onBack: () => void }> = (props) => {
  return (
    <section class="settings-subpage ignores-subpage" data-testid="ignores-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="ignores-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>ignore list</h3>
      </header>

      <div class="settings-section" data-testid="ignores-section">
        <h4 class="settings-section-heading">ignored masks</h4>
        <p class="settings-section-blurb">
          messages from these are dropped before they reach you — no scrollback, no badge, no push.
          a bare nick means <code>nick!*@*</code>; <code>*</code> and <code>?</code> are wildcards.
          per network, same list as <code>/ignore</code>. add an optional text pattern to drop only
          the lines whose body matches it — that is how one person behind a relay bot gets ignored
          without silencing the whole bridge (<code>/ignore relay!*@* &lt;SomeNick&gt;*</code>). the
          pattern matches the WHOLE line, so wrap it in <code>*</code> to match anywhere.
        </p>
        <Show
          when={(networks() ?? []).length > 0}
          fallback={<p class="watchlists-empty">no networks yet.</p>}
        >
          <For each={networks() ?? []}>{(net) => <IgnoreNetworkBlock net={net} />}</For>
        </Show>
      </div>
    </section>
  );
};

export default IgnoresSettings;
