import { type Component, createSignal, For, onCleanup, Show } from "solid-js";
import { type AdminSubjectSearchResult, adminSearchVhostSubjects } from "./lib/api";
import { token } from "./lib/auth";

// #257 — subject autocomplete for the admin vhost-grant form. ONE box over
// BOTH subject kinds (users + visitors); the operator types a name/nick,
// sees type-tagged results, and picks one. On select, the parent stores the
// result's STABLE `{type, id}` into the grant form (→ `{subject_type,
// subject_id}` on the wire) — cic never originates the tag, it mirrors the
// server's tagged union (CLAUDE.md "cic never originates state").
//
// SELECTION is parent-owned (lives in the grant form) so it can't desync
// from a post-grant form reset — the component only owns TRANSIENT search
// state (query / results / open / loading). Mirror of the controlled-input
// pattern; avoids the `feedback_solidjs_for_ref_leak` stale-selection class.

// Pure label for a result row / the selected chip. A visitor shows
// "network - nick" (disambiguates a multi-network visitor, #257); a user
// shows "account - nick" — a user has no single network, so we don't
// fabricate one. Exported for vitest.
export function formatSubjectLabel(r: AdminSubjectSearchResult): string {
  const prefix = r.type === "visitor" ? (r.network ?? "?") : "account";
  return `${prefix} - ${r.nick}`;
}

const DEBOUNCE_MS = 200;
const MIN_QUERY_LEN = 1;

type Props = {
  vhostId: number;
  hasSelection: boolean;
  selectedLabel: string;
  onSelect: (result: AdminSubjectSearchResult) => void;
  onClear: () => void;
};

const SubjectAutocomplete: Component<Props> = (props) => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<AdminSubjectSearchResult[]>([]);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  const runSearch = async (q: string): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    try {
      const rows = await adminSearchVhostSubjects(t, q);
      // Drop a stale / out-of-order response: only apply if the input still
      // reflects the query this request was dispatched for (the operator
      // may have kept typing or cleared the box while it was in flight).
      if (query().trim() !== q) return;
      setResults(rows);
      setOpen(true);
    } catch {
      // Search is best-effort — a transient failure just shows no matches;
      // the operator retries by typing. No error surface for an
      // autocomplete keystroke.
      if (query().trim() !== q) return;
      setResults([]);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const onInput = (value: string): void => {
    setQuery(value);
    if (timer !== undefined) clearTimeout(timer);
    const q = value.trim();
    if (q.length < MIN_QUERY_LEN) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer = setTimeout(() => {
      void runSearch(q);
    }, DEBOUNCE_MS);
  };

  const choose = (result: AdminSubjectSearchResult): void => {
    // Cancel any pending debounced search so a stale request can't fire
    // after the pick (consistent with onInput / onCleanup).
    if (timer !== undefined) clearTimeout(timer);
    props.onSelect(result);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  const clear = (): void => {
    setQuery("");
    setResults([]);
    setOpen(false);
    props.onClear();
  };

  return (
    <div class="subject-autocomplete" data-testid={`subject-autocomplete-${props.vhostId}`}>
      <Show
        when={!props.hasSelection}
        fallback={
          <span
            class="subject-autocomplete-selected"
            data-testid={`subject-autocomplete-selected-${props.vhostId}`}
          >
            {props.selectedLabel}
            <button
              type="button"
              class="subject-autocomplete-clear"
              aria-label={`clear grant subject for vhost ${props.vhostId}`}
              onClick={clear}
              data-testid={`subject-autocomplete-clear-${props.vhostId}`}
            >
              ✕
            </button>
          </span>
        }
      >
        <input
          type="text"
          class="subject-autocomplete-input"
          placeholder="search user or visitor…"
          autocomplete="off"
          value={query()}
          onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
          data-testid={`subject-autocomplete-input-${props.vhostId}`}
          aria-label={`grant subject search for vhost ${props.vhostId}`}
        />
        <Show when={open() && results().length > 0}>
          <ul
            class="subject-autocomplete-results"
            data-testid={`subject-autocomplete-results-${props.vhostId}`}
          >
            <For each={results()}>
              {(r) => (
                <li>
                  <button
                    type="button"
                    class="subject-autocomplete-option"
                    onClick={() => choose(r)}
                    data-testid={`subject-autocomplete-option-${props.vhostId}-${r.type}-${r.id}`}
                  >
                    <span class={`subject-autocomplete-type subject-autocomplete-type-${r.type}`}>
                      {r.type}
                    </span>
                    <span class="subject-autocomplete-label">{formatSubjectLabel(r)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show
          when={
            open() && !loading() && results().length === 0 && query().trim().length >= MIN_QUERY_LEN
          }
        >
          <p
            class="subject-autocomplete-empty muted"
            data-testid={`subject-autocomplete-empty-${props.vhostId}`}
          >
            no matches
          </p>
        </Show>
      </Show>
    </div>
  );
};

export default SubjectAutocomplete;
