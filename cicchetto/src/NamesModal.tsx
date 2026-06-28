import { type Component, For, Show } from "solid-js";
import type { MemberEntry } from "./lib/memberTypes";
import { memberSigil } from "./lib/memberSigil";
import { dismissNamesModal, namesModalBySlug } from "./lib/namesModal";
import { networks } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { selectedChannel, setSelectedChannel } from "./lib/selection";
import NickText, { type PrefixGlyph } from "./NickText";

// #140 — /names modal. Centered, scrollable, dismissable overlay
// rendering the roster from a `names_reply` event (Session.Server's
// buffered 353/366 drain). Mounted once per Shell branch (mobile +
// desktop); only one branch is live, so a single instance exists.
//
// Reads the roster for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `namesModalBySlug`
// store — mirrors how WhoisCard keys off its per-network store. The
// roster arrives tier-sorted (op > halfop > voice > plain, alpha within
// tier) from the server; cic buckets it into labeled sections.
//
// Interaction (per vjt #140 spec): grouped sections with per-section
// counts (empty sections hidden), a "#channel — N people" heading, and
// clicking a nick closes the modal + opens a query for that nick (the
// exact MembersPane left-click verb pair). Dismiss via ×, Esc, or
// backdrop. Ephemeral — dismissing just drops the store entry.

// Section buckets in irssi precedence order. A member lands in the
// highest tier it holds (an op who is also voiced shows under
// Operators). Predicates are mutually exclusive by the not-higher
// guards, so each member appears in exactly one section.
const SECTIONS: { label: string; inTier: (modes: string[]) => boolean }[] = [
  { label: "Operators", inTier: (m) => m.includes("@") },
  { label: "Halfops", inTier: (m) => !m.includes("@") && m.includes("%") },
  { label: "Voices", inTier: (m) => !m.includes("@") && !m.includes("%") && m.includes("+") },
  {
    label: "Users",
    inTier: (m) => !m.includes("@") && !m.includes("%") && !m.includes("+"),
  },
];

// modes → NickText prefix glyph. memberSigil returns " " for plain;
// NickText's PrefixGlyph union treats plain as "" (no leading-space
// span). Same translation MembersPane's `sigilToPrefix` does.
const toPrefix = (modes: string[]): PrefixGlyph => {
  const sigil = memberSigil(modes);
  return sigil === " " ? "" : sigil;
};

const NamesModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : namesModalBySlug()[slug];
  };

  // Refcounted overlay scroll-lock — same wiring as ArchiveModal /
  // MediaViewerModal. Tracks "is a roster shown for the active network?".
  // The scroller is `.names-modal-body` (header + footer are pinned), so
  // that's the registered element iOS is allowed to pan.
  createOverlayLock(() => bundle() !== undefined, ".names-modal-body");

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissNamesModal(slug);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  // Spec #140 — clicking a nick opens a query window + switches focus,
  // then closes the modal. Mirrors MembersPane's left-click verb pair
  // (canonicalQueryNick → openQueryWindowState → setSelectedChannel) so
  // both entry points compose the same stores. Race-safe: no-op when
  // networks() hasn't resolved (leaves the modal open).
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
        const sections = (): { label: string; members: MemberEntry[] }[] =>
          SECTIONS.map((s) => ({
            label: s.label,
            members: b.members.filter((m) => s.inTier(m.modes)),
          })).filter((s) => s.members.length > 0);
        const total = (): number => b.members.length;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="names-modal-backdrop" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="names-modal-title"
              class="names-modal"
              data-testid="names-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onKeyDown}
              tabIndex={-1}
            >
              <header class="names-modal-header">
                <h2 id="names-modal-title">
                  {b.channel} — {total()} {total() === 1 ? "person" : "people"}
                </h2>
                <button
                  type="button"
                  class="names-modal-close"
                  aria-label="close names"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div class="names-modal-body">
                <For each={sections()}>
                  {(section) => (
                    <section class="names-modal-section">
                      <h3 class="names-modal-section-title">
                        {section.label} ({section.members.length})
                      </h3>
                      <ul class="names-modal-section-grid">
                        <For each={section.members}>
                          {(m) => (
                            <li>
                              <button
                                type="button"
                                class="names-modal-nick"
                                onClick={() => onNickClick(b.network, m.nick)}
                              >
                                <NickText nick={m.nick} prefix={toPrefix(m.modes)} />
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
              </div>
              <footer class="names-modal-footer">End of /NAMES list: {total()}</footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default NamesModal;
