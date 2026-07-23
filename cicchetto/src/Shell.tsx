import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import AdminPane from "./AdminPane";
import ArchiveModal from "./ArchiveModal";
import AudioMiniPlayer from "./AudioMiniPlayer";
import BottomBar from "./BottomBar";
import ComposeBox from "./ComposeBox";
import ConfirmModal from "./ConfirmModal";
import CrtSplash from "./CrtSplash";
import DiagFloat from "./DiagFloat";
import DirectoryPane from "./DirectoryPane";
import ErrorBanners from "./ErrorBanners";
import HomePane from "./HomePane";
import { jumpToNextActiveWindow, jumpToPrevActiveWindow } from "./lib/activeWindows";
import { ownNickForNetwork } from "./lib/api";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { getDraft, setDraft, tabComplete } from "./lib/compose";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { loadLastFocused } from "./lib/lastFocusedChannel";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import {
  openAdminPanel,
  openArchivePanel,
  openHomePanel,
  openSettingsPanel,
  openThemesPanel,
  toggleMembersPanel,
} from "./lib/mobilePanel";
import { channelsBySlug, isAdmin, networkBySlug, networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
import { queryWindowsByNetwork } from "./lib/queryWindows";
import { closeToPreviousWindow, selectedChannel, setSelectedChannel } from "./lib/selection";
import { settingsOpenTick } from "./lib/settingsNav";
import { isMobile } from "./lib/theme";
import { loadUploadTtlSeconds } from "./lib/uploadOrchestrator";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  kindHasScrollback,
} from "./lib/windowKinds";
import { isActiveChannelJoined } from "./lib/windowState";
import MediaViewerModal from "./MediaViewerModal";
import MembersPane from "./MembersPane";
import MentionsWindow from "./MentionsWindow";
import ModeModal from "./ModeModal";
import NamesModal from "./NamesModal";
import NextActiveButton from "./NextActiveButton";
import PresenceToasts from "./PresenceToasts";
import PrivacyModal from "./PrivacyModal";
import ResizeHandle from "./ResizeHandle";
import ScrollbackPane from "./ScrollbackPane";
import ServerReplyModal from "./ServerReplyModal";
import ServiceModal from "./ServiceModal";
import SettingsDrawer from "./SettingsDrawer";
import ShellChrome from "./ShellChrome";
import Sidebar from "./Sidebar";
import ThemeEditor from "./ThemeEditor";
import TopicBar from "./TopicBar";
import UmodeModal from "./UmodeModal";
import WhoModal from "./WhoModal";

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

  // #356 — cross-module "open settings" request. A bare watch-family compose
  // verb (/notify, /watch, /hilight, …) can't reach the local setSettingsOpen,
  // so it bumps settingsOpenTick (settingsNav.requestOpenSettings, which also
  // stashes the pending sub-page). Opening the drawer fires its own open
  // transition, which consumes the pending page and jumps to "watchlists".
  // The initial run (tick 0 vs prev 0) is a no-op; each later bump opens.
  let prevSettingsTick = settingsOpenTick();
  createEffect(() => {
    const tick = settingsOpenTick();
    if (tick !== prevSettingsTick) {
      prevSettingsTick = tick;
      setSettingsOpen(true);
    }
  });

  // BUGHUNT-3 sub-cluster D (2026-05-25) — single memo for the
  // selection-kind dispatch. Pre-fix Shell rendered nested `<Show>`
  // chains that each independently subscribed to `selectedChannel()`
  // and re-evaluated `sel().kind === ...` checks. When selection
  // transitioned from `kind: "channel"` (#bofh) to `kind: "admin"`,
  // the outer admin gate Show flipped TRUE and began disposing the
  // fallback subtree (TopicBar + ScrollbackPane + ComposeBox) WHILE
  // the inner `<Show when={selectedChannel()}>{(sel)=>...}>` ALSO
  // re-fired its `sel().kind === "channel"` check on the new admin
  // value mid-disposal. The concurrent owner-tree walks collided
  // inside Solid's `cleanNode` — `for(i=node.owned.length-1...
  // cleanNode(node.owned[i])` read a now-nulled `node.owned[t]`,
  // throwing `TypeError: null is not an object (evaluating
  // 'e.owned[t]')`. The throw broke the AdminPane Show mount cycle
  // AND halted all downstream Solid reactivity — UI completely
  // frozen on desktop + mobile (vjt prod-confirmed). Switch/Match
  // collapses all kind branches into ONE memo edge so disposal is
  // atomic — the previous subtree fully tears down before the new
  // branch begins mounting, no concurrent owner-tree mutation.
  const isAdminPaneVisible = createMemo(() => selectedChannel()?.kind === "admin" && isAdmin());
  const selKind = createMemo(() => selectedChannel()?.kind ?? null);

  // UX-6 bucket A — refcounted overlay scroll-lock for the two
  // Shell-owned mobile overlays (members drawer + AdminPane). The
  // settings drawer + archive modal + image-upload modal manage
  // their own push/pop inside their components — Shell only handles
  // the two surfaces whose open state lives here. The lock only
  // engages on mobile (`isMobile()`) since desktop has fixed-grid
  // layouts that don't suffer the iOS gesture-escalation class.
  //
  // v4: scroll-lock target is the actual scroller — `.members-pane`
  // for members drawer, `.admin-pane` for admin window. Looked up
  // via queueMicrotask so SolidJS commits the render-effects of the
  // signal change before we hand the element to
  // body-scroll-lock-upgrade.
  let wasMembersOpen = false;
  let membersLockedEl: HTMLElement | null = null;
  createEffect(() => {
    const open = isMobile() && membersOpen();
    if (open && !wasMembersOpen) {
      wasMembersOpen = true;
      queueMicrotask(() => {
        membersLockedEl = document.querySelector<HTMLElement>(
          ".shell-mobile .shell-members .members-pane",
        );
        pushOverlay(membersLockedEl);
      });
    } else if (!open && wasMembersOpen) {
      wasMembersOpen = false;
      popOverlay(membersLockedEl);
      membersLockedEl = null;
    }
  });
  onCleanup(() => {
    if (wasMembersOpen) {
      wasMembersOpen = false;
      popOverlay(membersLockedEl);
      membersLockedEl = null;
    }
  });

  let wasAdminOpen = false;
  let adminLockedEl: HTMLElement | null = null;
  createEffect(() => {
    const sel = selectedChannel();
    const open = isMobile() && isAdmin() && sel?.kind === "admin";
    if (open && !wasAdminOpen) {
      wasAdminOpen = true;
      queueMicrotask(() => {
        adminLockedEl = document.querySelector<HTMLElement>(".admin-pane");
        pushOverlay(adminLockedEl);
      });
    } else if (!open && wasAdminOpen) {
      wasAdminOpen = false;
      popOverlay(adminLockedEl);
      adminLockedEl = null;
    }
  });
  onCleanup(() => {
    if (wasAdminOpen) {
      wasAdminOpen = false;
      popOverlay(adminLockedEl);
      adminLockedEl = null;
    }
  });

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
    // GH #235 — next/prev unread now route through the shared
    // `activeWindows` ordering (mention/query tier first, chronological
    // within a tier, cycling), the SAME verb the Alt+A keybinding and
    // the on-screen affordance button call. This is a strict upgrade
    // over the previous sidebar-index walk: it also reaches query (DM)
    // windows, which the old impl skipped.
    nextUnread: () => jumpToNextActiveWindow(),
    prevUnread: () => jumpToPrevActiveWindow(),
    insertIntoCompose: (char: string) => {
      const sel = selectedChannel();
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      const next = getDraft(key) + char;
      setDraft(key, next);
      const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
      if (!ta) return;
      // UX-6 D9 — `preventScroll: true` short-circuits iOS Safari's
      // "scroll the focused input into view" auto-scroll path
      // (WebKit `_zoomToFocusRect` in WKContentView). Baseline since
      // iOS Safari 15.5 (mid-2022); no fallback needed for our PWA
      // target. Without this, iOS shifts the layout viewport up by
      // ~vv.offsetTop to "center" the textarea — which is the
      // root cause of UX-6-D bugs 1+2 we chased for 8 iterations.
      ta.focus({ preventScroll: true });
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
      // tabComplete wrote the draft via writeState (calling setDraft here
      // would null the cycle). We only place the caret. Solid signal write
      // doesn't reflect immediately — schedule on the next microtask.
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
  // `$home` window. Fires after `user()` (the /me resource) resolves.
  // Does NOT override an operator selection — if a channel was clicked
  // between mount and /me-arrival, the guard below keeps that selection.
  //
  // Replaces the prior /names N-3 first-joined-channel auto-select.
  // The home pane IS the new landing window for both visitor and
  // registered identities; the operator navigates to specific
  // channels via the sidebar / BottomBar / keybindings.
  //
  // Issue #35 (2026-06-01) — before defaulting to `$home`, restore the
  // last focused channel/query/server window from localStorage
  // (`lib/lastFocusedChannel.ts`). Validity gate:
  //   * channel → must appear in `channelsBySlug()[slug]`.
  //   * query   → must appear in `queryWindowsByNetwork()[net.id]`.
  //   * server  → its network must be live in `networkBySlug(slug)`.
  //
  // Issue #187 (2026-07-05) — TWO changes, both to make restore work for
  // VISITORS (registered users already worked; visitors were the gap):
  //   1. No subject-kind gate. A visitor's `/me` id is a stable UUID
  //      (resolved from the persisted grappa-token), keying the same
  //      `cic.lastFocusedChannel.<id>` slot the focus-write in selection.ts
  //      already fills for every subject — so restore keys on `m.id` for
  //      any class, not just `kind === "user"`.
  //   2. Reactive, not decide-once. A registered user's saved channel is an
  //      autojoin — always in the FIRST `channelsBySlug` snapshot. A
  //      visitor's saved channel is runtime-joined: the bouncer session
  //      survives the reload, but `/channels` can snapshot mid-reconnect and
  //      return WITHOUT it under load, the channel arriving a beat later via
  //      a refetch. A decide-once arm latched `$home` before it and stranded
  //      the visitor — the exact #187 symptom. So the effect keeps
  //      re-attempting the restore (each branch reads the very resource that
  //      will gain the target, so it re-runs when the window lands), landing
  //      `$home` PROVISIONALLY meanwhile so the screen is never blank, and
  //      overriding it when the saved window appears. It stops the instant
  //      the operator navigates. If the saved window never appears (parted
  //      while cic was closed), `$home` is the correct terminal fallback.
  let coldLoadDone = false;
  let provisionalHome = false;
  createEffect(() => {
    if (coldLoadDone) return;

    const sel = selectedChannel();
    // The operator navigated to a real window (or one was pre-seeded) —
    // cold load is over. Our OWN provisional `$home` does not count: while
    // it stands we keep watching for the saved window to arrive.
    if (sel !== null && !(provisionalHome && sel.kind === "home")) {
      coldLoadDone = true;
      return;
    }

    // Wait for /me + the channels resource's first resolve. `createResource`
    // returns `undefined` while loading; a resolved empty object `{}` is
    // truthy and means "no channels yet".
    const m = user();
    if (!m) return;
    const cbs = channelsBySlug();
    if (cbs === undefined) return;

    const saved = loadLastFocused(m.id);
    if (saved === null) {
      // No saved window → land on `$home` and finish.
      if (sel === null) {
        setSelectedChannel({
          networkSlug: HOME_WINDOW_SLUG,
          channelName: HOME_WINDOW_NAME,
          kind: "home",
        });
      }
      coldLoadDone = true;
      return;
    }

    const slug = saved.networkSlug;
    let restored = false;
    if (saved.kind === "channel") {
      const list = cbs[slug] ?? [];
      if (list.some((c) => c.name === saved.channelName)) {
        setSelectedChannel({
          networkSlug: slug,
          channelName: saved.channelName,
          kind: "channel",
        });
        restored = true;
      }
    } else if (saved.kind === "query") {
      const net = networkBySlug(slug);
      if (net) {
        const qs = queryWindowsByNetwork()[net.id] ?? [];
        const match = qs.find((q) => nickEquals(q.targetNick, saved.channelName));
        if (match !== undefined) {
          setSelectedChannel({
            networkSlug: slug,
            channelName: match.targetNick,
            kind: "query",
          });
          restored = true;
        }
      }
    } else if (saved.kind === "server") {
      if (networkBySlug(slug) !== undefined) {
        setSelectedChannel({
          networkSlug: slug,
          channelName: saved.channelName,
          kind: "server",
        });
        restored = true;
      }
    }

    if (restored) {
      provisionalHome = false;
      coldLoadDone = true;
      return;
    }

    // Saved window not present YET — land on `$home` provisionally (never a
    // blank screen) but do NOT latch: this effect re-runs when the tracked
    // resource above updates, and the re-run overrides `$home` once the
    // saved window arrives.
    if (sel === null) {
      setSelectedChannel({
        networkSlug: HOME_WINDOW_SLUG,
        channelName: HOME_WINDOW_NAME,
        kind: "home",
      });
      provisionalHome = true;
    }
  });

  return (
    <Show
      when={isMobile()}
      fallback={
        // ── Desktop three-pane layout (unchanged from pre-C6) ─────────
        <div class="shell" classList={{ "shell-no-members": !isActiveChannelJoined() }}>
          <ErrorBanners />
          <PresenceToasts />
          <PrivacyModal />
          <MediaViewerModal />
          <NamesModal />
          <ThemeEditor />
          <WhoModal />
          <ModeModal />
          <UmodeModal />
          <ServerReplyModal />
          <ServiceModal />
          <ConfirmModal />
          <aside class="shell-sidebar">
            <Sidebar />
            {/* GH #235 — "jump to next active window" affordance, pinned
                bottom-left of the sidebar. Self-hides when nothing is
                unread. */}
            <NextActiveButton variant="desktop" />
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
            {/* #134 — the Switch fallback only renders when
                selectedChannel() is null, i.e. the cold-load window
                before the auto-select effect lands on $home. That IS the
                loading state, so the fallback is the retro CRT splash;
                CrtSplash self-gates on the same loading predicate and
                hands off (renders null) once load completes. */}
            <Switch fallback={<CrtSplash />}>
              <Match when={isAdminPaneVisible()}>
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
              </Match>
              <Match when={kindHasScrollback(selKind())}>
                {/* BUGHUNT-3 D — channel + query + server share ONE Match
                    so ScrollbackPane stays mounted across kind transitions
                    (channel↔query↔server). The pane's `on(key, prevKey)`
                    effect at ScrollbackPane.tsx:~1142 owns the leave-arm
                    cursor write; splitting these kinds into separate
                    Matches would unmount + remount the pane and fire
                    `onCleanup` (which can't read the leaving pane's
                    `lastFullyVisibleRowId` reliably because listRef may
                    be stale at the dispose tick). TopicBar is gated
                    inside on the channel-only kind to preserve its
                    channel-window-only contract. */}
                <Show when={selKind() === "channel"}>
                  <TopicBar
                    networkSlug={selectedChannel()?.networkSlug ?? ""}
                    channelName={selectedChannel()?.channelName ?? ""}
                    onToggleMembers={() => setMembersOpen((v) => !v)}
                  />
                </Show>
                <ScrollbackPane
                  networkSlug={selectedChannel()?.networkSlug ?? ""}
                  channelName={selectedChannel()?.channelName ?? ""}
                  kind={(selKind() as "channel" | "query" | "server") ?? "channel"}
                />
                {/* GH #115 — docked audio mini-player, above compose.
                    Inside this Match so it survives channel↔query↔server
                    switches (the kindHasScrollback Match stays mounted);
                    leaving chat for home/list/mentions stops playback. */}
                <AudioMiniPlayer />
                <ComposeBox
                  networkSlug={selectedChannel()?.networkSlug ?? ""}
                  channelName={selectedChannel()?.channelName ?? ""}
                />
              </Match>
              <Match when={selKind() === "mentions"}>
                {/* C8.1 — mentions window. Rendered instead of ScrollbackPane+ComposeBox.
                    onMentionClicked will navigate to channel + scroll-to-timestamp (C8.2). */}
                <MentionsWindow
                  bundle={
                    mentionsBundleBySlug()[selectedChannel()?.networkSlug ?? ""] ?? {
                      network_slug: selectedChannel()?.networkSlug ?? "",
                      away_started_at: "",
                      away_ended_at: "",
                      away_reason: null,
                      messages: [],
                    }
                  }
                  ownNick={ownNickForSlug(selectedChannel()?.networkSlug ?? "")}
                  onMentionClicked={handleMentionClicked}
                  onClose={() => closeToPreviousWindow(selectedChannel()?.networkSlug ?? "")}
                />
              </Match>
              <Match when={selKind() === "home"}>
                {/* UX-4 bucket B — home pane. No TopicBar, no
                    ComposeBox, no MembersPane (sibling <aside>
                    already self-gates on isActiveChannelJoined). */}
                <HomePane />
              </Match>
              <Match when={selKind() === "list"}>
                {/* #84 E3 — channel directory pane. No TopicBar, no
                    ComposeBox, no MembersPane. The $list window is a
                    view+action pane (browse + join), not a chat pane. */}
                <DirectoryPane networkSlug={selectedChannel()?.networkSlug ?? ""} />
              </Match>
            </Switch>
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
        {/* UX-6 D6 — DiagFloat lives in a Portal mounted on document.body
            so it is anchored to the layout viewport independent of this
            subtree (visible above the on-screen keyboard during
            convergence probing). NB: `.shell-mobile` is NOT a
            transform/containing block today (verified #264 — see
            DESIGN_NOTES); the Portal keeps DiagFloat robust should one
            ever be added. `position: fixed` descendants (e.g.
            `.next-active-btn-mobile`) likewise anchor to the viewport —
            do NOT add a `transform` to `.shell-mobile` without revisiting
            #264's keyboard-ride. */}
        <Portal>
          <DiagFloat />
        </Portal>
        <ErrorBanners />
        <PresenceToasts />
        <PrivacyModal />
        <MediaViewerModal />
        <NamesModal />
        <ThemeEditor />
        <WhoModal />
        <UmodeModal />
        <ModeModal />
        <ServerReplyModal />
        <ServiceModal />
        <ConfirmModal />
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
          {/* #134 — CRT loading splash (mobile). Same loading-only
              contract as desktop: the fallback is the cold-load state. */}
          <Switch fallback={<CrtSplash />}>
            <Match when={isAdminPaneVisible()}>
              <AdminPane
                onClose={() =>
                  setSelectedChannel({
                    networkSlug: HOME_WINDOW_SLUG,
                    channelName: HOME_WINDOW_NAME,
                    kind: "home",
                  })
                }
              />
            </Match>
            <Match when={kindHasScrollback(selKind())}>
              {/* BUGHUNT-3 D — channel + query + server share ONE Match
                  so ScrollbackPane stays mounted across kind transitions.
                  See desktop branch comment for details. */}
              <Show when={selKind() === "channel"}>
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
                  networkSlug={selectedChannel()?.networkSlug ?? ""}
                  channelName={selectedChannel()?.channelName ?? ""}
                  onToggleMembers={() =>
                    toggleMembersPanel({
                      membersOpen,
                      setMembersOpen,
                      setSettingsOpen,
                    })
                  }
                />
              </Show>
              <ScrollbackPane
                networkSlug={selectedChannel()?.networkSlug ?? ""}
                channelName={selectedChannel()?.channelName ?? ""}
                kind={(selKind() as "channel" | "query" | "server") ?? "channel"}
              />
              {/* GH #115 — docked audio mini-player, above compose (mobile). */}
              <AudioMiniPlayer />
              <ComposeBox
                networkSlug={selectedChannel()?.networkSlug ?? ""}
                channelName={selectedChannel()?.channelName ?? ""}
              />
            </Match>
            <Match when={selKind() === "mentions"}>
              <MentionsWindow
                bundle={
                  mentionsBundleBySlug()[selectedChannel()?.networkSlug ?? ""] ?? {
                    network_slug: selectedChannel()?.networkSlug ?? "",
                    away_started_at: "",
                    away_ended_at: "",
                    away_reason: null,
                    messages: [],
                  }
                }
                ownNick={ownNickForSlug(selectedChannel()?.networkSlug ?? "")}
                onMentionClicked={handleMentionClicked}
                onClose={() => closeToPreviousWindow(selectedChannel()?.networkSlug ?? "")}
              />
            </Match>
            <Match when={selKind() === "home"}>
              {/* UX-4 bucket B — home pane on mobile. Same HomePane
                  component as desktop; layout is the only branch
                  difference. */}
              <HomePane />
            </Match>
            <Match when={selKind() === "list"}>
              {/* #84 E3 — channel directory pane on mobile. Same
                  DirectoryPane component as desktop. */}
              <DirectoryPane networkSlug={selectedChannel()?.networkSlug ?? ""} />
            </Match>
          </Switch>
        </section>

        <BottomBar />

        {/* GH #235 — "jump to next active window" affordance (mobile).
            #280: on scrollback windows (channel/query/server) it renders
            INSIDE ScrollbackPane's float stack — stacked with
            scroll-to-bottom, anchored to the message container. Here it
            covers the NON-scrollback windows (home / mentions / list /
            admin), which have no pane to anchor to and no scroll-to-bottom
            to collide with, keeping the viewport-fixed placement.
            Mutually exclusive via `kindHasScrollback` so exactly one
            mobile next-active mounts. Self-hides when nothing is unread. */}
        <Show when={!kindHasScrollback(selKind())}>
          <NextActiveButton variant="mobile" />
        </Show>

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
            {/* #291 — home launcher. Mobile narrow layout has no other way
                back to the home window (desktop has the sidebar home link).
                Always visible, leftmost (footer left-aligns per #291);
                selection-driven dispatch mirrors the admin launcher. */}
            <button
              type="button"
              class="shell-chrome-btn shell-chrome-home"
              aria-label="open home"
              data-testid="mobile-panel-home"
              onClick={() =>
                openHomePanel({ membersOpen, setMembersOpen, setSettingsOpen }, () =>
                  setSelectedChannel({
                    networkSlug: HOME_WINDOW_SLUG,
                    channelName: HOME_WINDOW_NAME,
                    kind: "home",
                  }),
                )
              }
            >
              {"\u{1F3E0}"}
            </button>
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
              {"\u{2699}\u{FE0F}"}
            </button>
            {/* #75/#332 — themes launcher: opens the settings drawer directly on
                the themes gallery sub-page (openThemesPanel deep-links via
                settingsNav). #299 removed this (footer overflowed at 5 buttons,
                clipping admin); #332 (P0, vjt) restored it — the footer now
                `flex-wrap`s (default.css `.mobile-panel-actions`), so a 5th
                button wraps to a new row instead of clipping admin off-screen. */}
            <button
              type="button"
              class="shell-chrome-btn shell-chrome-themes"
              aria-label="open themes"
              data-testid="mobile-panel-themes"
              onClick={() => openThemesPanel({ membersOpen, setMembersOpen, setSettingsOpen })}
            >
              {"\u{1F3A8}"}
            </button>
            {/* UX-6 bucket C (2026-05-21) — admin launcher: admin
                console. Visible only when `isAdmin()` is true (single
                source of truth shared with Sidebar admin row +
                SettingsDrawer admin entry). Selection-driven dispatch
                mirrors the Sidebar handler — Shell mounts AdminPane on
                `selectedChannel.kind === "admin"`. Mutex via
                openAdminPanel: closes members/settings/archive before
                navigating, same shape as openSettingsPanel /
                openArchivePanel. */}
            <Show when={isAdmin()}>
              <button
                type="button"
                class="shell-chrome-btn shell-chrome-admin"
                aria-label="open admin"
                data-testid="mobile-panel-admin"
                onClick={() =>
                  openAdminPanel({ membersOpen, setMembersOpen, setSettingsOpen }, () =>
                    setSelectedChannel({
                      networkSlug: ADMIN_WINDOW_SLUG,
                      channelName: ADMIN_WINDOW_NAME,
                      kind: "admin",
                    }),
                  )
                }
              >
                {"\u{1F527}"}
              </button>
            </Show>
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
