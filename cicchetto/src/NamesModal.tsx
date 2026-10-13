import { type Component, For, Show } from "solid-js";
import { prefixForSlug, sigilRankForSlug } from "./lib/casemapping";
import { memberSigil } from "./lib/memberSigil";
import type { MemberEntry } from "./lib/memberTypes";
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

// issue 1999 — the section ladder used to be this hardcoded array of four
// mutually-exclusive `@ % +` predicates, so on a PREFIX-rich network a
// founder fell through every guard and was listed under "Users". Sections
// are now GENERATED, one per sigil the network advertised, in the order it
// advertised them (`sigilRankForSlug`), plus the trailing plain bucket. A
// member lands in the section of their HIGHEST-ranked sigil, which
// `memberSigil` already decides — bucketing by its answer makes the
// sections exclusive by construction rather than by hand-written
// not-higher guards.
//
// The LABELS are a display vocabulary this modal owns, keyed by mode
// letter. That is the same split `channelModes.MEMBERSHIP_MODE_NAMES`
// makes and for the same reason: the SET and the RANK are the network's
// and must never be hardcoded, but a Title-Case plural heading is cic's
// own copy, and it differs from the lowercase singular that prose surface
// wants ("delivered to ops and voice only"). A letter nobody named renders
// as `mode +<letter>` — the same generic shape `modeDescription` uses.
const SECTION_LABELS: Record<string, string> = {
  q: "Founders",
  a: "Admins",
  o: "Operators",
  h: "Halfops",
  v: "Voices",
};

const PLAIN_SECTION_LABEL = "Users";

const sectionLabel = (letter: string): string => SECTION_LABELS[letter] ?? `mode +${letter}`;

// modes → NickText prefix glyph. memberSigil returns " " for plain;
// NickText treats plain as "" (no leading-space span). Same translation
// MembersPane's `sigilToPrefix` does.
const toPrefix = (modes: string[], rank: readonly string[]): PrefixGlyph => {
  const sigil = memberSigil(modes, rank);
  return sigil === " " ? "" : sigil;
};

const NamesModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : namesModalBySlug()[slug];
  };

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissNamesModal(slug);
  };

  // Refcounted overlay scroll-lock — same wiring as ArchiveModal /
  // MediaViewerModal. Tracks "is a roster shown for the active network?".
  // The scroller is `.names-modal-body` (header + footer are pinned), so
  // that's the registered element iOS is allowed to pan. #232 — the shared
  // Esc-to-close routes through the same lock (topmost-first, focus-independent).
  createOverlayLock(() => bundle() !== undefined, ".names-modal-body", close);

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
        const rank = (): string[] => sigilRankForSlug(b.network);
        const prefixMap = (): Record<string, string> => prefixForSlug(b.network);
        // One bucket per advertised sigil, rank order, then plain. The label
        // is looked up by the sigil's mode LETTER, reverse-resolved through
        // the network's own PREFIX map — never by the sigil character, which
        // means nothing without the network that advertised it.
        const sections = (): { label: string; members: MemberEntry[] }[] => {
          const run = rank();
          const letters = prefixMap();
          const buckets = run.map((sigil) => ({
            label: sectionLabel(Object.keys(letters).find((l) => letters[l] === sigil) ?? sigil),
            members: b.members.filter((m) => memberSigil(m.modes, run) === sigil),
          }));
          buckets.push({
            label: PLAIN_SECTION_LABEL,
            members: b.members.filter((m) => memberSigil(m.modes, run) === " "),
          });
          return buckets.filter((s) => s.members.length > 0);
        };
        const total = (): number => b.members.length;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="modal-backdrop modal-backdrop-viewport names-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="names-modal-title"
              class="names-modal"
              data-testid="names-modal"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="names-modal-header">
                <h2 id="names-modal-title">
                  {b.channel} — {total()} {total() === 1 ? "person" : "people"}
                </h2>
                <button
                  type="button"
                  class="modal-chrome-button names-modal-close"
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
                                class="names-modal-nick selectable-text"
                                onClick={() => onNickClick(b.network, m.nick)}
                              >
                                <NickText nick={m.nick} prefix={toPrefix(m.modes, rank())} />
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
