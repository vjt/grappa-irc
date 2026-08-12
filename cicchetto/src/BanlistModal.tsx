import { type Component, createSignal, For, Show } from "solid-js";
import { banlistCardBySlug } from "./lib/banlistCard";
import { banlistModalState, closeBanlistModal, openBanlistModal } from "./lib/banlistModal";
import { type BanMaskForm, buildBanMask } from "./lib/banMask";
import { ownHoldsChannelEditorSigil } from "./lib/channelEditPerm";
import { canonicalChannel, channelKey } from "./lib/channelKey";
import { friendlyError } from "./lib/friendlyError";
import { isupportForNetwork } from "./lib/isupport";
import { listModeLabel, listModeTitle } from "./lib/listModes";
import { networks } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import {
  pushChannelBan,
  pushChannelBanlist,
  pushChannelUnban,
  resolveUserhost,
} from "./lib/socket";

// #386 — ban-management modal. The interactive `/banlist` surface: list the
// channel's `+b` masks (mask · set-by · time), ADD a ban via an easy mask
// builder (nick → one of three forms), and REMOVE a ban in one click.
// Supersedes the #376 inline BanlistCard (mirrors how the #169 /who modal
// replaced the inline WHO dump) — one code path, `/banlist` opens THIS.
//
// Data sources (all server-owned, cic mirrors — no client state origination):
//   * ban rows ← the #376 `banlist_bundle` store (`banlistCardBySlug`),
//     re-queried on open + on demand (Refresh) via `pushChannelBanlist`.
//   * op-gate HINT ← `ownHoldsChannelEditorSigil` (op `@` or halfop `%`; the
//     same o+h derivation ModeModal uses). vjt decision #2: this is only a
//     visual de-emphasis — the mutating actions stay ALWAYS CLICKABLE, because
//     ChanServ/IRCop authority never shows in the members map. The ircd's 482
//     is the real gate and surfaces as an inline error.
//   * mask components (user/host) ← the on-demand `resolveUserhost` lookup
//     (cic has no per-member host); a cache MISS is fail-closed (vjt decision
//     #1: no wider-mask guess — surface "run /whois first").
//
// #1251 — the surface is now EVERY type-A list the network offers, not just
// `+b`: the mode switcher renders `isupport.listModesQueryable` (server data,
// never derived here) and each switch re-queries. Editing stays `+b`-only —
// the ADD/REMOVE path goes through the `ban`/`unban` verbs, which derive a
// mask from a bare nick and chunk per ISUPPORT `MODES=`; generalising that is
// a separate verb pair, not a widened modal. For the other lists this is a
// viewer, and the hint points at the `/mode` form that edits them.

// cic owns time formatting (moved from the #376 BanlistCard). `set_ts` is the
// raw upstream unix-epoch STRING; render it in the viewer's locale, NaN-guarded.
function formatBanSetAt(setTs: string | null): string | null {
  if (setTs === null) return null;
  const epoch = Number.parseInt(setTs, 10);
  if (Number.isNaN(epoch)) return setTs; // defensive: non-numeric → show raw
  return new Date(epoch * 1000).toLocaleString();
}

// The three mask-builder forms (issue #386). Default "host" — vjt decision #1
// (host-ban, the offender's host verbatim, no domain/octet wildcard).
const FORMS: { value: BanMaskForm; label: string }[] = [
  { value: "host", label: "*!*@host" },
  { value: "nick", label: "nick!*@*" },
  { value: "user_host", label: "*!user@host" },
];

const BanlistModal: Component = () => {
  const target = () => banlistModalState();
  const [maskInput, setMaskInput] = createSignal("");
  const [form, setForm] = createSignal<BanMaskForm>("host");
  const [error, setError] = createSignal<string | null>(null);

  const networkId = (): number | undefined => {
    const t = target();
    return t ? networks()?.find((n) => n.slug === t.networkSlug)?.id : undefined;
  };

  // Rows for THIS modal's channel AND mode. The #376 store holds one bundle
  // per network; show it only when its (folded) channel matches the modal
  // target, so a stale prior-channel bundle doesn't flash during the
  // open→re-query. #1251 adds the mode to that guard for the same reason:
  // after switching b→e the ban bundle is still the newest one in the store,
  // and rendering it under an "Exempts" heading would be a lie.
  const bundle = () => {
    const t = target();
    if (!t) return undefined;
    const b = banlistCardBySlug()[t.networkSlug];
    if (!b) return undefined;
    if (b.mode !== t.mode) return undefined;
    return canonicalChannel(b.channel) === canonicalChannel(t.channel) ? b : undefined;
  };

  // #1251 — the letters this NETWORK can be asked for, straight from 005 (the
  // server publishes the intersection with what it can parse). Never derived
  // here; an unseeded network falls back to the shared default table.
  const queryableModes = (): string[] => {
    const id = networkId();
    return id === undefined ? [] : isupportForNetwork(id).listModesQueryable;
  };

  // Editing is `+b` only for now — `ban`/`unban` are the verbs that derive a
  // mask from a bare nick and chunk per ISUPPORT MODES=. The other lists are
  // read-only here and edited with `/mode #chan +e <mask>`.
  const editable = (): boolean => (target()?.mode ?? "b") === "b";

  const switchMode = (mode: string): void => {
    const t = target();
    const id = networkId();
    if (!t || id === undefined || t.mode === mode) return;
    setError(null);
    openBanlistModal(t.networkSlug, t.channel, mode);
    pushChannelBanlist(id, t.channel, mode);
  };

  // Op-gate HINT only (never a hard block, vjt decision #2).
  const canEdit = (): boolean => {
    const t = target();
    const id = networkId();
    if (!t || id === undefined) return false;
    return ownHoldsChannelEditorSigil(t.networkSlug, channelKey(t.networkSlug, t.channel), id);
  };

  const refresh = (): void => {
    const t = target();
    const id = networkId();
    if (t && id !== undefined) pushChannelBanlist(id, t.channel, t.mode);
  };

  const onAdd = async (): Promise<void> => {
    setError(null);
    const t = target();
    const id = networkId();
    if (!t || id === undefined) return;
    const raw = maskInput().trim();
    if (raw === "") {
      setError("enter a nick or a mask");
      return;
    }

    // An explicit mask (already carries !/@/*) passes verbatim; a bare nick
    // goes through the mask builder for the selected form.
    let mask: string | null;
    if (/[!@*]/.test(raw)) {
      mask = raw;
    } else if (form() === "nick") {
      mask = buildBanMask("nick", { nick: raw, user: null, host: null });
    } else {
      // host / user_host need the offender's userhost — on-demand lookup,
      // fail-closed on a miss (no wider guess).
      let uh: { user: string; host: string } | null;
      try {
        uh = await resolveUserhost(id, raw);
      } catch (e) {
        setError(`couldn't look up ${raw}: ${friendlyError(e)}`);
        return;
      }
      mask = uh ? buildBanMask(form(), { nick: raw, user: uh.user, host: uh.host }) : null;
      if (mask === null) {
        setError(`host unknown for ${raw} — run /whois ${raw} first`);
        return;
      }
    }

    // Narrow away the `nick`-form builder's `string | null` (never null for a
    // present nick, but tsc can't prove it) before the push.
    if (mask === null) {
      setError("couldn't build a ban mask");
      return;
    }

    try {
      await pushChannelBan(id, t.channel, mask);
      setMaskInput("");
      refresh();
    } catch (e) {
      setError(`ban failed: ${friendlyError(e)}`);
    }
  };

  const onRemove = async (mask: string): Promise<void> => {
    setError(null);
    const t = target();
    const id = networkId();
    if (!t || id === undefined) return;
    try {
      await pushChannelUnban(id, t.channel, mask);
      refresh();
    } catch (e) {
      setError(`unban failed: ${friendlyError(e)}`);
    }
  };

  // Overlay refcount so the covered pane freezes + #232 shared Esc-to-close.
  createOverlayLock(() => banlistModalState() !== null, ".banlist-modal", closeBanlistModal);

  return (
    <Show when={target()}>
      {(t) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
        <div
          class="modal-backdrop modal-backdrop-viewport banlist-modal-backdrop"
          onClick={closeBanlistModal}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="banlist-modal-title"
            class="banlist-modal"
            data-testid="banlist-modal"
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            <header class="banlist-modal-header">
              <h2 id="banlist-modal-title">
                {listModeTitle(t().mode, t().channel)}
                <Show when={!canEdit()}>
                  <span class="banlist-modal-hint"> (not opped — the server decides)</span>
                </Show>
              </h2>
              <button
                type="button"
                class="modal-chrome-button banlist-modal-close"
                aria-label="close ban list"
                onClick={closeBanlistModal}
              >
                ×
              </button>
            </header>

            <div class="banlist-modal-body">
              <Show when={error()}>
                <p class="banlist-modal-error" data-testid="banlist-modal-error">
                  {error()}
                </p>
              </Show>

              {/* #1251 — one button per list this network offers. Rendered
                  only when there is a choice to make: on a network with a
                  single queryable list the switcher would be furniture. */}
              <Show when={queryableModes().length > 1}>
                <div class="banlist-modal-modes" data-testid="banlist-mode-switcher">
                  <For each={queryableModes()}>
                    {(mode) => (
                      <button
                        type="button"
                        class="banlist-modal-mode-btn"
                        classList={{ "banlist-modal-mode-active": mode === t().mode }}
                        aria-pressed={mode === t().mode}
                        data-testid={`banlist-mode-${mode}`}
                        onClick={() => switchMode(mode)}
                      >
                        {listModeLabel(mode)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!editable()}>
                <p class="banlist-modal-readonly muted" data-testid="banlist-modal-readonly">
                  read-only here — set with{" "}
                  <code>
                    /mode {t().channel} +{t().mode} &lt;mask&gt;
                  </code>
                </p>
              </Show>

              {/* Add row — de-emphasised when not opped, but ALWAYS clickable. */}
              <Show when={editable()}>
                <div class="banlist-modal-add" classList={{ "banlist-modal-deemph": !canEdit() }}>
                  <input
                    type="text"
                    class="banlist-modal-add-input"
                    data-testid="banlist-add-input"
                    aria-label="nick or mask to ban"
                    placeholder="nick or mask"
                    value={maskInput()}
                    onInput={(e) => setMaskInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onAdd();
                    }}
                  />
                  <select
                    class="banlist-modal-add-form"
                    data-testid="banlist-add-form"
                    aria-label="ban mask form"
                    value={form()}
                    onChange={(e) => setForm(e.currentTarget.value as BanMaskForm)}
                  >
                    <For each={FORMS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
                  </select>
                  <button
                    type="button"
                    class="banlist-modal-add-btn"
                    data-testid="banlist-add-btn"
                    onClick={() => void onAdd()}
                  >
                    Add ban
                  </button>
                </div>
              </Show>

              <Show
                when={bundle()}
                fallback={
                  <p class="banlist-modal-empty muted">
                    Loading {listModeLabel(t().mode).toLowerCase()}…
                  </p>
                }
              >
                {(b) => (
                  <Show
                    when={b().entries.length > 0}
                    fallback={
                      <p class="banlist-modal-empty muted">
                        no {listModeLabel(t().mode).toLowerCase()} set on {t().channel}
                      </p>
                    }
                  >
                    <ul class="banlist-modal-rows">
                      <For each={b().entries}>
                        {(entry) => (
                          <li class="banlist-modal-row">
                            <span class="banlist-modal-mask">{entry.mask}</span>
                            <Show when={entry.setter}>
                              <span class="banlist-modal-setter muted">set by {entry.setter}</span>
                            </Show>
                            <Show when={formatBanSetAt(entry.set_ts)}>
                              {(time) => <span class="banlist-modal-time muted">{time()}</span>}
                            </Show>
                            <Show when={editable()}>
                              <button
                                type="button"
                                class="banlist-modal-remove"
                                classList={{ "banlist-modal-deemph": !canEdit() }}
                                data-testid="banlist-remove-btn"
                                aria-label={`remove ban ${entry.mask}`}
                                onClick={() => void onRemove(entry.mask)}
                              >
                                ×
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                )}
              </Show>
            </div>

            <footer class="banlist-modal-footer">
              <button
                type="button"
                class="banlist-modal-refresh"
                data-testid="banlist-refresh"
                onClick={refresh}
              >
                Refresh
              </button>
            </footer>
          </div>
        </div>
      )}
    </Show>
  );
};

export default BanlistModal;
