import { type Component, For, Show } from "solid-js";
import type { WhoUser } from "./lib/api";
import { networks } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { selectedChannel, setSelectedChannel } from "./lib/selection";
import { dismissWhoModal, whoModalBySlug } from "./lib/whoModal";
import { MircBody } from "./MircText";
import NickText, { type PrefixGlyph } from "./NickText";

// #169 — /who modal. Centered, scrollable, dismissable overlay rendering the
// parsed per-user rows from a `who_reply` event (Session.Server's buffered
// 352/315 drain). Mirrors NamesModal (same overlay/scroll-lock/dismiss/nick-
// click scaffolding); the body differs — a flat per-user TABLE (nick, flags,
// user@host, server, hops, realname) instead of the sigil-grouped names
// roster. Mounted once per Shell branch (mobile + desktop); only one branch
// is live, so a single instance exists.
//
// Reads the roster for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `whoModalBySlug`
// store. Rows arrive in server WHO order (event_router preserves wire order);
// cic renders them as-is. Ephemeral — dismissing just drops the store entry.
// Clicking a nick closes the modal + opens a query (the MembersPane verb
// pair). Dismiss via ×, Esc, or backdrop.

// WHO flags string → NickText prefix glyph. WHO flags carry the away marker
// (H/G) plus the channel-status prefix (@/%/+); extract the highest-
// precedence status glyph for the nick, mirroring NamesModal's sigil
// precedence. The full flags string is still shown in its own column.
const whoPrefix = (modes: string): PrefixGlyph => {
  if (modes.includes("@")) return "@";
  if (modes.includes("%")) return "%";
  if (modes.includes("+")) return "+";
  return "";
};

// #176 — decode the raw 352 flags string into human labels. The flags field is
// an ordered string of single chars (e.g. "H@", "G*"); the server passes it
// through verbatim (EventRouter stores the raw field as `modes` — no server
// decode). This mapping is CLIENT-side, consistent with the `whoPrefix`
// precedent (cic already reads `modes`) and the fork resolution A (no wire
// change, HOT --cic). Labels + colors are cic-owned display strings — NOT mIRC
// codes — so they render as CSS-styled chips, never through MircBody.
//
// Known chars map to a label + css modifier (colors reuse the existing sigil
// tokens in default.css). An unknown/future char degrades to a neutral chip
// showing the raw char — bahamut can emit flags grappa never enumerated, and
// dropping one would silently lose information; surfacing the raw char is the
// honest fallback.
type WhoFlagChip = { label: string; cssMod: string };

const WHO_FLAG_LABELS: Record<string, WhoFlagChip> = {
  H: { label: "here", cssMod: "here" },
  G: { label: "gone", cssMod: "gone" },
  "*": { label: "ircop", cssMod: "ircop" },
  "@": { label: "chanop", cssMod: "chanop" },
  "%": { label: "halfop", cssMod: "halfop" },
  "+": { label: "voice", cssMod: "voice" },
  S: { label: "secure", cssMod: "secure" },
};

const decodeWhoFlags = (modes: string): WhoFlagChip[] =>
  [...modes].map((ch) => WHO_FLAG_LABELS[ch] ?? { label: ch, cssMod: "unknown" });

const WhoModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : whoModalBySlug()[slug];
  };

  // Refcounted overlay scroll-lock — same wiring as NamesModal. Tracks "is a
  // roster shown for the active network?". The scroller is `.who-modal-body`
  // (header + footer are pinned).
  createOverlayLock(() => bundle() !== undefined, ".who-modal-body");

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissWhoModal(slug);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  // Clicking a nick opens a query window + switches focus, then closes the
  // modal. Mirrors NamesModal / MembersPane's left-click verb pair
  // (canonicalQueryNick → openQueryWindowState → setSelectedChannel). Race-
  // safe: no-op when networks() hasn't resolved (leaves the modal open).
  const onNickClick = (slug: string, nick: string): void => {
    const nid = networks()?.find((n) => n.slug === slug)?.id;
    if (nid === undefined) return;
    const canonical = canonicalQueryNick(nid, nick);
    openQueryWindowState(nid, canonical, new Date().toISOString());
    setSelectedChannel({ networkSlug: slug, channelName: canonical, kind: "query" });
    close();
  };

  return (
    <Show when={bundle()} keyed>
      {(b) => {
        const total = (): number => b.users.length;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="who-modal-backdrop" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="who-modal-title"
              class="who-modal"
              data-testid="who-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onKeyDown}
              tabIndex={-1}
            >
              <header class="who-modal-header">
                <h2 id="who-modal-title">
                  {b.target} — {total()} {total() === 1 ? "user" : "users"}
                </h2>
                <button
                  type="button"
                  class="who-modal-close"
                  aria-label="close who"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div class="who-modal-body">
                <ul class="who-modal-rows">
                  <For each={b.users}>
                    {(u: WhoUser) => (
                      // #176 — one word-wrapping COLUMN block per user (was a
                      // flat single flex-row that overflowed sideways). Head
                      // line = nick + decoded flag chips; then realname, host,
                      // and server/hops each on their own wrapping line.
                      <li class="who-modal-row" data-testid="who-modal-row">
                        <div class="who-modal-line who-modal-line-head">
                          <button
                            type="button"
                            class="who-modal-nick"
                            onClick={() => onNickClick(b.network, u.nick)}
                          >
                            <NickText nick={u.nick} prefix={whoPrefix(u.modes)} />
                          </button>
                          {/* #176 — decoded flag chips. cic-owned display
                              labels colored per flag via CSS — NOT mIRC codes,
                              so they do NOT route through MircBody. */}
                          <span class="who-modal-flags">
                            <For each={decodeWhoFlags(u.modes)}>
                              {(chip) => (
                                <span
                                  class={`who-modal-flag-tag who-modal-flag-tag-${chip.cssMod}`}
                                >
                                  {chip.label}
                                </span>
                              )}
                            </For>
                          </span>
                        </div>
                        <Show when={u.realname}>
                          {/* #175/#176 — the WHO realname (gecos) is arbitrary
                              user free-text carrying mIRC control bytes; route
                              it through the shared renderer (keep the #175
                              MircBody wrapping) and give it its OWN word-
                              wrapping line. The other fields (nick, flags,
                              user@host, server, hops) are identifiers and stay
                              literal. */}
                          <div class="who-modal-line who-modal-line-realname">
                            <span class="who-modal-realname">
                              <MircBody body={u.realname ?? ""} />
                            </span>
                          </div>
                        </Show>
                        <div class="who-modal-line who-modal-line-host">
                          <span class="who-modal-userhost">
                            {u.user}@{u.host}
                          </span>
                        </div>
                        <div class="who-modal-line who-modal-line-meta">
                          <span class="who-modal-server">{u.server}</span>
                          <Show when={u.hops !== null}>
                            <span class="who-modal-hops">· {u.hops} hops</span>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
              <footer class="who-modal-footer">End of /WHO list: {total()}</footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default WhoModal;
