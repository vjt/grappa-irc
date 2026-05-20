import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import AdminPane from "./AdminPane";
import ArchiveModal from "./ArchiveModal";
import BottomBar from "./BottomBar";
import BundleRefreshBanner from "./BundleRefreshBanner";
import ComposeBox from "./ComposeBox";
import HomePane from "./HomePane";
import { ownNickForNetwork } from "./lib/api";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { getDraft, setDraft, tabComplete } from "./lib/compose";
import { loadUploadTtlSeconds } from "./lib/imageUploadOrchestrator";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { openArchivePanel, openSettingsPanel, toggleMembersPanel } from "./lib/mobilePanel";
import { channelsBySlug, isAdmin, networkBySlug, networks, user } from "./lib/networks";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";
import { isMobile } from "./lib/theme";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
} from "./lib/windowKinds";
import { isActiveChannelJoined } from "./lib/windowState";
import MembersPane from "./MembersPane";
import MentionsWindow from "./MentionsWindow";
import PrivacyModal from "./PrivacyModal";
import ResizeHandle from "./ResizeHandle";
import ScrollbackPane from "./ScrollbackPane";
import SettingsDrawer from "./SettingsDrawer";
import ShellChrome from "./ShellChrome";
import Sidebar from "./Sidebar";
import SocketHealthBanner from "./SocketHealthBanner";
import TopicBar from "./TopicBar";

// Three-pane responsive shell. Composition root for Sidebar / TopicBar /
// ScrollbackPane / ComposeBox / MembersPane / SettingsDrawer / BottomBar.
//
// Drawer state lives here:
//   * membersOpen — right members-list drawer (desktop + mobile via single hamburger)
//   * settingsOpen — full-cover settings overlay (desktop+mobile)
//
// UX-5 bucket A (2026-05-19) — the left `sidebarOpen` drawer was
// dropped. The desktop sidebar is always visible (no toggle needed);
// the mobile branch doesn't render `.shell-sidebar` at all (channels
// live in BottomBar). The ShellChrome hamburger that toggled this
// signal is removed end-to-end — it duplicated TopicBar's members
// hamburger on mobile and toggled a no-op `.open` class on desktop.
//
// Mobile layout (≤768px, isMobile() reactive signal from theme.ts):
//   * JSX branches on isMobile() — NOT just CSS display toggling.
//   * Mobile branch: TopicBar (single hamburger for members) → Scrollback
//     → ComposeBox → BottomBar. Full-width. No left sidebar.
//   * Desktop branch: unchanged three-pane layout (sidebar | main | members).
//
// Keybindings: Shell is the only consumer of `keybindings.registerHandlers`
// + `install`. Action callbacks drive selection (Alt+1..9, Ctrl+N/P),
// drawer state (Esc), irssi-style compose auto-focus + insert (any
// printable key off-compose), and tab-complete (Tab in compose textarea).
// install() is idempotent; uninstall fires on unmount.

const Shell: Component = () => {
  const [membersOpen, setMembersOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // UX-4 bucket N — admin pane lifecycle is now selection-driven.
  // `selectedChannel.kind === "admin"` is the SINGLE source of truth
  // for the AdminPane mount (replacing the M-7 parallel `adminOpen`
  // signal). Triggers:
  //   * Sidebar admin row click (UX-4 bucket N — primary, always-
  //     visible affordance for admins).
  //   * SettingsDrawer "admin console" entry (M-7 secondary trigger,
  //     kept as a fallback per the "two doors, one room" rule).
  // Both call setSelectedChannel({kind: "admin", ...ADMIN_*}).
  //
  // Visibility gate `isAdmin()` lives in `lib/networks.ts` — single
  // source of truth shared with SettingsDrawer (drawer entry) +
  // Sidebar (admin row). Pane mount further gates on `isAdmin()`
  // here so a stale selection (kind === "admin" persisted across
  // a demote) can't reach AdminPane content for a non-admin user.
  //
  // Demote-mid-session: when `me.is_admin` flips to false (another
  // admin demotes this operator, OR the bearer rotates to a
  // non-admin user), the createEffect below redirects selection
  // back to home if currently on admin. Sidebar admin row vanishes
  // via the same `isAdmin()` predicate. Drawer entry hides via the
  // mirror predicate in SettingsDrawer.

  // M-7 demote redirect — when the operator loses admin AND is
  // currently on the admin window, navigate back to home so the
  // pane doesn't fall through to the empty "select a channel"
  // fallback (which would be visually startling). Selection-driven
  // model: setting kind === "home" both hides the AdminPane (Shell's
  // `<Show when={sel.kind === "admin"}>` flips false) and lands the
  // operator on a deterministic landing window.
  //
  // Correctness depends on `user()` (createResource accessor in
  // lib/networks.ts) keeping the prior value across refetches rather
  // than transiently returning `undefined` — which would redirect
  // home mid-admin-operation. createResource's `previous` semantics
  // hold this invariant today.
  createEffect(() => {
    if (isAdmin()) return;
    const sel = selectedChannel();
    if (sel?.kind !== "admin") return;
    setSelectedChannel({
      networkSlug: HOME_WINDOW_SLUG,
      channelName: HOME_WINDOW_NAME,
      kind: "home",
    });
  });

  // Per-network own IRC nick — derived via `ownNickForNetwork(net, me)`
  // so the mention-highlight in MentionsWindow sees the IRC nick the
  // operator runs under on THIS network (not the account name, which
  // can drift after NickServ ghost recovery or when the account name
  // happens to match an unrelated peer's nick on a network where the
  // operator's configured nick is different). See `lib/api.ts`
  // ownNickForNetwork docstring for the canonical resolution rules.
  // Bucket F H1 fix: pre-fix this called `displayNick(me)` which
  // returned account name and silently mis-highlighted peer mentions.
  const ownNickForSlug = (slug: string): string | null => {
    const me = user();
    if (!me) return null;
    const net = networkBySlug(slug);
    if (!net) return null;
    return ownNickForNetwork(net, me);
  };

  // UX-5 bucket BM (2026-05-20) — archive-launcher visibility in the
  // mobile members drawer footer mirrors ShellChrome's archive gate
  // (no archive on home / mentions / admin / pre-select). Predicate
  // lives in `lib/archiveContext.ts` so both surfaces edit one rule.

  // C8.2 — click-to-context handler for MentionsWindow rows.
  // CP29 R-4: previously this called `setReadCursor(slug, ch, serverTime-1)`
  // to position the unread-marker just before the clicked message. The
  // server-side cursor model (id-based, forward-only, validated against
  // (subject, network, channel)) cannot express "rewind to just before
  // an arbitrary timestamp" — the MentionsBundle wire shape doesn't
  // even carry message ids, only server_time. Drop the cursor-rewind
  // here; focus-switch alone still navigates the operator to the
  // mention's window. Restoring "scroll to mention with marker just
  // above" requires a wider fix (extend MentionsBundle wire shape with
  // message id + thread the id through to a one-shot scroll-to verb in
  // ScrollbackPane). Deferred — separate cluster.
  const handleMentionClicked = (args: {
    networkSlug: string;
    channel: string;
    serverTime: number;
  }) => {
    setSelectedChannel({
      networkSlug: args.networkSlug,
      channelName: args.channel,
      kind: "channel",
    });
  };

  // Linear flat list of (slug, channel) tuples for Alt+1..9 + next/prev
  // unread navigation. Read inside handlers so it picks up fresh state
  // each call.
  const flatChannels = (): { slug: string; name: string }[] => {
    const cbs = channelsBySlug() ?? {};
    const out: { slug: string; name: string }[] = [];
    for (const net of networks() ?? []) {
      for (const ch of cbs[net.slug] ?? []) {
        out.push({ slug: net.slug, name: ch.name });
      }
    }
    return out;
  };

  registerHandlers({
    selectChannelByIndex: (idx) => {
      const list = flatChannels();
      const target = list[idx];
      if (target)
        setSelectedChannel({ networkSlug: target.slug, channelName: target.name, kind: "channel" });
    },
    nextUnread: () => {
      const list = flatChannels();
      const counts = unreadCounts();
      const sel = selectedChannel();
      const startIdx = sel
        ? list.findIndex((c) => c.slug === sel.networkSlug && c.name === sel.channelName)
        : -1;
      for (let i = 1; i <= list.length; i += 1) {
        const idx = (startIdx + i) % list.length;
        const c = list[idx];
        if (!c) continue;
        if ((counts[channelKey(c.slug, c.name)] ?? 0) > 0) {
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name, kind: "channel" });
          return;
        }
      }
    },
    prevUnread: () => {
      const list = flatChannels();
      const counts = unreadCounts();
      const sel = selectedChannel();
      const startIdx = sel
        ? list.findIndex((c) => c.slug === sel.networkSlug && c.name === sel.channelName)
        : list.length;
      for (let i = 1; i <= list.length; i += 1) {
        const idx = (startIdx - i + list.length) % list.length;
        const c = list[idx];
        if (!c) continue;
        if ((counts[channelKey(c.slug, c.name)] ?? 0) > 0) {
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name, kind: "channel" });
          return;
        }
      }
    },
    insertIntoCompose: (char: string) => {
      const sel = selectedChannel();
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      const next = getDraft(key) + char;
      setDraft(key, next);
      const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
      if (!ta) return;
      ta.focus();
      // Solid signal write doesn't immediately reflect in the textarea;
      // schedule the caret placement on the next microtask so the value
      // update has flushed.
      queueMicrotask(() => {
        ta.setSelectionRange(next.length, next.length);
      });
    },
    closeDrawer: () => {
      setMembersOpen(false);
      setSettingsOpen(false);
    },
    cycleNickComplete: (forward) => {
      const sel = selectedChannel();
      if (!sel) return;
      const ta = document.activeElement as HTMLTextAreaElement | null;
      if (!ta || ta.tagName.toLowerCase() !== "textarea") return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      // Read the current draft from the store (not ta.value) so the
      // matcher sees the post-store-write text — otherwise typing fast
      // before the signal flushes back to the textarea misses chars.
      const current = getDraft(key);
      const result = tabComplete(key, current, ta.selectionStart, forward);
      if (!result) return;
      setDraft(key, result.newInput);
      // Solid signal write doesn't immediately reflect in the textarea
      // — schedule the cursor placement on the next microtask.
      queueMicrotask(() => {
        ta.setSelectionRange(result.newCursor, result.newCursor);
      });
    },
  });
  install();
  onCleanup(uninstall);

  // UX-4 bucket M (2026-05-19) — populate the cic-side upload-TTL
  // cache once per app start, when both /me has resolved AND the
  // bearer is available. The orchestrator's dispatchUpload reads from
  // this cache; without an early load the operator's saved
  // preference would be ignored on the FIRST upload after a reload
  // (until the operator opens the SettingsDrawer at least once).
  // One-shot: disarms forever via `uploadTtlBootstrapped` after the
  // first successful fire — token + user are stable across the
  // session, so re-firing on signal churn is wasted REST traffic.
  let uploadTtlBootstrapped = false;
  createEffect(() => {
    if (uploadTtlBootstrapped) return;
    const t = token();
    const m = user();
    if (t === null || !m) return;
    uploadTtlBootstrapped = true;
    void loadUploadTtlSeconds(t);
  });

  // Auto-close the members drawer when the active selection no longer
  // has a member-list-shaped UI (DM, server, mentions, parked/failed/
  // kicked channel). Otherwise the open-state lingers and the next
  // joined-channel selection re-opens the drawer immediately, fighting
  // user intent. defer: true skips the initial run (no drawer to close
  // before any user interaction).
  createEffect(
    on(
      isActiveChannelJoined,
      (joined) => {
        if (!joined) setMembersOpen(false);
      },
      { defer: true },
    ),
  );

  // UX-4 bucket B (2026-05-18) — cold-load default lands on the
  // `$home` window. ONE-SHOT: fires once after `user()` (the /me
  // resource) resolves, then disarms forever via `coldLoadAutoSelected`.
  // Does NOT override an existing selection — if the operator clicked
  // a channel between mount and /me-arrival, the early-return at
  // `selectedChannel() !== null` keeps the click-driven selection.
  //
  // Replaces the prior /names N-3 first-joined-channel auto-select.
  // The home pane IS the new landing window for both visitor and
  // registered identities; the operator navigates to specific
  // channels via the sidebar / BottomBar / keybindings.
  let coldLoadAutoSelected = false;
  createEffect(() => {
    if (coldLoadAutoSelected) return;
    if (selectedChannel() !== null) {
      coldLoadAutoSelected = true;
      return;
    }
    // Wait for /me to land before we can pick a default at all.
    const m = user();
    if (!m) return;
    // Default landing: home window. Both registered + visitor.
    setSelectedChannel({
      networkSlug: HOME_WINDOW_SLUG,
      channelName: HOME_WINDOW_NAME,
      kind: "home",
    });
    coldLoadAutoSelected = true;
  });

  return (
    <Show
      when={isMobile()}
      fallback={
        // ── Desktop three-pane layout (unchanged from pre-C6) ─────────
        <div class="shell" classList={{ "shell-no-members": !isActiveChannelJoined() }}>
          <SocketHealthBanner />
          <BundleRefreshBanner />
          <PrivacyModal />
          <aside class="shell-sidebar">
            <Sidebar />
            {/* UX-5 bucket BS — drag handle on the inner edge of the
                left sidebar. Desktop-only (mobile branch never mounts
                it). Width persists to localStorage via
                lib/sidebarWidths.ts; CSS var --sidebar-width drives the
                .shell grid template. */}
            <ResizeHandle side="left" />
          </aside>

          <Show when={membersOpen()}>
            <div
              class="shell-drawer-backdrop open"
              onClick={() => setMembersOpen(false)}
              aria-hidden="true"
            />
          </Show>

          <section class="shell-main">
            {/* UX-4 bucket L (2026-05-19) — ShellChrome is always
                rendered, regardless of selected window kind. Cluster-
                wide rule: settings cog MUST be reachable from every
                window (channel / query / server / home / mentions /
                admin / empty). Pre-bucket the cog lived inside
                TopicBar (channel-kind only) + per-branch fallbacks.

                UX-5 bucket A (2026-05-19) — hamburger prop dropped.
                Desktop sidebar is always visible (no toggle); the
                mobile members drawer is opened by TopicBar's own
                hamburger (channel-window-only). */}
            <ShellChrome onOpenSettings={() => setSettingsOpen(true)} />
            <Show
              when={selectedChannel()?.kind === "admin" && isAdmin()}
              fallback={
                <Show
                  when={selectedChannel()}
                  fallback={<p class="muted">select a channel to view scrollback</p>}
                >
                  {(sel) => (
                    <>
                      <Show when={sel().kind === "channel"}>
                        <TopicBar
                          networkSlug={sel().networkSlug}
                          channelName={sel().channelName}
                          onToggleMembers={() => setMembersOpen((v) => !v)}
                        />
                      </Show>
                      <Show
                        when={sel().kind === "home"}
                        fallback={
                          <Show
                            when={sel().kind === "mentions"}
                            fallback={
                              <>
                                <ScrollbackPane
                                  networkSlug={sel().networkSlug}
                                  channelName={sel().channelName}
                                  kind={sel().kind}
                                />
                                {/* CP13 S9: ComposeBox renders on $server too —
                                    slash-only is enforced inside compose.ts so plain
                                    text gets rejected with a friendly error. */}
                                <ComposeBox
                                  networkSlug={sel().networkSlug}
                                  channelName={sel().channelName}
                                />
                              </>
                            }
                          >
                            {/* C8.1 — mentions window. Rendered instead of ScrollbackPane+ComposeBox.
                                onMentionClicked will navigate to channel + scroll-to-timestamp (C8.2). */}
                            <MentionsWindow
                              bundle={
                                mentionsBundleBySlug()[sel().networkSlug] ?? {
                                  network_slug: sel().networkSlug,
                                  away_started_at: "",
                                  away_ended_at: "",
                                  away_reason: null,
                                  messages: [],
                                }
                              }
                              ownNick={ownNickForSlug(sel().networkSlug)}
                              onMentionClicked={handleMentionClicked}
                            />
                          </Show>
                        }
                      >
                        {/* UX-4 bucket B — home pane. No TopicBar, no
                            ComposeBox, no MembersPane (sibling <aside>
                            already self-gates on isActiveChannelJoined). */}
                        <HomePane />
                      </Show>
                    </>
                  )}
                </Show>
              }
            >
              {/* UX-4 bucket N — AdminPane mount driven by selection +
                  isAdmin guard. onClose navigates back to home, mirroring
                  the demote-redirect effect; both paths terminate at the
                  same landing window. */}
              <AdminPane
                onClose={() =>
                  setSelectedChannel({
                    networkSlug: HOME_WINDOW_SLUG,
                    channelName: HOME_WINDOW_NAME,
                    kind: "home",
                  })
                }
              />
            </Show>
          </section>

          <aside class="shell-members" classList={{ open: membersOpen() }}>
            {/* UX-5 bucket BS — drag handle on the inner edge of the
                right (members) sidebar. Mounted unconditionally even
                when isActiveChannelJoined() is false (the column
                collapses via .shell-no-members in CSS); the handle is
                inside the aside so it's hidden together. */}
            <ResizeHandle side="right" />
            <Show when={isActiveChannelJoined() && selectedChannel()}>
              {(sel) => (
                <MembersPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
              )}
            </Show>
          </aside>

          <SettingsDrawer
            open={settingsOpen()}
            onClose={() => setSettingsOpen(false)}
            onOpenAdmin={() =>
              setSelectedChannel({
                networkSlug: ADMIN_WINDOW_SLUG,
                channelName: ADMIN_WINDOW_NAME,
                kind: "admin",
              })
            }
          />
        </div>
      }
    >
      {/* ── Mobile layout ──────────────────────────────────────────────
          Spec #10 mobile reshape. Vertical order top→bottom:
            TopicBar (single hamburger — members only; no channel hamburger)
            Scrollback (1fr)
            ComposeBox
            BottomBar (window picker, horizontal scroll, UNDER compose)
          Members pane: slide-in-from-right drawer toggled by the single
          hamburger in TopicBar (aria-label "open members sidebar").
          Channel sidebar (.shell-sidebar) is NOT rendered on mobile —
          channels are navigated via BottomBar. This is a full JSX branch,
          not a CSS-display toggle, so the sidebar DOM is absent entirely.
      */}
      <div class="shell shell-mobile">
        <SocketHealthBanner />
        <BundleRefreshBanner />
        <PrivacyModal />
        <Show when={membersOpen()}>
          <div
            class="shell-drawer-backdrop open"
            onClick={() => setMembersOpen(false)}
            aria-hidden="true"
          />
        </Show>

        <section class="shell-main">
          {/* Mobile-non-channel windows (home / mentions / admin /
              server) render the standalone .shell-chrome row for
              archive + cog. Mobile-channel suppresses this row
              entirely — UX-5 bucket BM moved the archive + cog to the
              members drawer footer below (see `.shell-members` aside),
              so the channel scrollback reclaims the ~32px the chrome
              row used to steal above. Earlier history of this surface
              in the bucket commits (UX-4 L, UX-5 A, UX-5 BT, UX-5 BM). */}
          <Show when={selectedChannel()?.kind !== "channel"}>
            <ShellChrome onOpenSettings={() => setSettingsOpen(true)} />
          </Show>
          <Show
            when={selectedChannel()?.kind === "admin" && isAdmin()}
            fallback={
              <Show when={selectedChannel()} fallback={<p class="muted">select a channel below</p>}>
                {(sel) => (
                  <>
                    <Show when={sel().kind === "channel"}>
                      {/* C6.3 / UX-5 bucket A: TopicBar's
                          `.topic-bar-hamburger` is the single
                          members-drawer toggle on mobile (CSS-hidden
                          on desktop via @media). ShellChrome above no
                          longer renders its own hamburger.
                          UX-5 bucket BM (2026-05-20) — `inlineChromeSlot`
                          dropped on mobile-channel: archive + cog
                          buttons moved INTO the members drawer footer
                          (see below). TopicBar's right edge now hosts
                          ONLY the hamburger. onToggleMembers routes
                          through `toggleMembersPanel` to enforce the
                          members | settings | archive | none mutex —
                          opening members closes the sibling surfaces. */}
                      <TopicBar
                        networkSlug={sel().networkSlug}
                        channelName={sel().channelName}
                        onToggleMembers={() =>
                          toggleMembersPanel({
                            membersOpen,
                            setMembersOpen,
                            setSettingsOpen,
                          })
                        }
                      />
                    </Show>
                    <Show
                      when={sel().kind === "home"}
                      fallback={
                        <Show
                          when={sel().kind === "mentions"}
                          fallback={
                            <>
                              <ScrollbackPane
                                networkSlug={sel().networkSlug}
                                channelName={sel().channelName}
                                kind={sel().kind}
                              />
                              {/* CP13 S9: ComposeBox renders on $server too —
                                  slash-only is enforced inside compose.ts so plain
                                  text gets rejected with a friendly error. */}
                              <ComposeBox
                                networkSlug={sel().networkSlug}
                                channelName={sel().channelName}
                              />
                            </>
                          }
                        >
                          <MentionsWindow
                            bundle={
                              mentionsBundleBySlug()[sel().networkSlug] ?? {
                                network_slug: sel().networkSlug,
                                away_started_at: "",
                                away_ended_at: "",
                                away_reason: null,
                                messages: [],
                              }
                            }
                            ownNick={ownNickForSlug(sel().networkSlug)}
                            onMentionClicked={handleMentionClicked}
                          />
                        </Show>
                      }
                    >
                      {/* UX-4 bucket B — home pane on mobile. Same HomePane
                          component as desktop; layout is the only branch
                          difference. */}
                      <HomePane />
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            <AdminPane
              onClose={() =>
                setSelectedChannel({
                  networkSlug: HOME_WINDOW_SLUG,
                  channelName: HOME_WINDOW_NAME,
                  kind: "home",
                })
              }
            />
          </Show>
        </section>

        <BottomBar />

        {/* UX-2 (2026-05-17) — Mobile archive overlay. Mounted ONLY
            in the mobile branch (desktop uses Sidebar's per-network
            `<details>` archive section instead). Self-gated on
            `archiveModalNetwork()` — renders nothing when closed. */}
        <ArchiveModal />

        <aside class="shell-members" classList={{ open: membersOpen() }}>
          <Show when={isActiveChannelJoined() && selectedChannel()}>
            {(sel) => (
              <MembersPane
                networkSlug={sel().networkSlug}
                channelName={sel().channelName}
                onMemberSelect={() => setMembersOpen(false)}
              />
            )}
          </Show>
          {/* UX-5 bucket BM (2026-05-20) — bottom-fixed launcher row
              inside the mobile members drawer. Replaces the archive +
              cog buttons that UX-5 BT inlined into the TopicBar; with
              three affordances on a narrow row the chrome was getting
              crowded (vjt 2026-05-19 dogfood). Mutex enforced via
              lib/mobilePanel.ts: tapping settings/archive closes the
              drawer before opening the launched surface, and the
              hamburger's own toggle (toggleMembersPanel above) closes
              the launched surfaces before opening the drawer.
              Archive launcher renders only when there's a network
              context — same `archiveSlugForSelection()` rule that
              gates the standalone ShellChrome archive button. */}
          <footer class="mobile-panel-actions">
            <Show when={archiveSlugForSelection()}>
              {(slug) => (
                <button
                  type="button"
                  class="shell-chrome-btn shell-chrome-archive"
                  aria-label="open archive"
                  data-testid="mobile-panel-archive"
                  onClick={() =>
                    openArchivePanel({ membersOpen, setMembersOpen, setSettingsOpen }, slug())
                  }
                >
                  {"\u{1F4C2}"}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="shell-chrome-btn shell-chrome-cog"
              aria-label="open settings"
              data-testid="mobile-panel-settings"
              onClick={() => openSettingsPanel({ membersOpen, setMembersOpen, setSettingsOpen })}
            >
              ⚙
            </button>
          </footer>
        </aside>

        <SettingsDrawer
          open={settingsOpen()}
          onClose={() => setSettingsOpen(false)}
          onOpenAdmin={() =>
            setSelectedChannel({
              networkSlug: ADMIN_WINDOW_SLUG,
              channelName: ADMIN_WINDOW_NAME,
              kind: "admin",
            })
          }
        />
      </div>
    </Show>
  );
};

export default Shell;
