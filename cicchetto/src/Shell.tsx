import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import AdminPane from "./AdminPane";
import ArchiveModal from "./ArchiveModal";
import AudioDock from "./AudioDock";
import AudioMiniPlayer from "./AudioMiniPlayer";
import BanlistModal from "./BanlistModal";
import BottomBar from "./BottomBar";
import ComposeBox from "./ComposeBox";
import ConfirmModal from "./ConfirmModal";
import CreditsModal from "./CreditsModal";
import CrtSplash from "./CrtSplash";
import DiagFloat from "./DiagFloat";
import DirectoryPane from "./DirectoryPane";
import DropUploadZone from "./DropUploadZone";
import ErrorBanners from "./ErrorBanners";
import HomePane from "./HomePane";
import LinksModal from "./LinksModal";
import { jumpToNextActiveWindow, jumpToPrevActiveWindow } from "./lib/activeWindows";
import { ownNickForNetwork } from "./lib/api";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { getDraft, tabComplete } from "./lib/compose";
import { appendToCompose } from "./lib/composeAppend";
import { placeCaretInView } from "./lib/composeCaret";
import { casemappingForNetwork } from "./lib/isupport";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { loadLastFocused } from "./lib/lastFocusedChannel";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { openMembersPanel, toggleMembersPanel } from "./lib/mobilePanel";
import { channelsBySlug, isAdmin, networkBySlug, networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock, overlayCount } from "./lib/overlayScrollLock";
import { queryWindowsByNetwork } from "./lib/queryWindows";
import {
  closeToPreviousWindow,
  selectedChannel,
  selectStatusWindow,
  setSelectedChannel,
} from "./lib/selection";
import { settingsOpenTick } from "./lib/settingsNav";
import { getShowBottomBar } from "./lib/showBottomBar";
import { isMobile } from "./lib/theme";
import { bindEdgeGesture } from "./lib/touchGesture";
import { loadUploadConfirmEnabled, loadUploadTtlSeconds } from "./lib/uploadOrchestrator";
import { HOME_WINDOW_NAME, HOME_WINDOW_SLUG, kindHasScrollback } from "./lib/windowKinds";
import { isActiveChannelJoined } from "./lib/windowState";
import MediaViewerModal from "./MediaViewerModal";
import MembersPane from "./MembersPane";
import MentionsWindow from "./MentionsWindow";
import ModeModal from "./ModeModal";
import NamesModal from "./NamesModal";
import NextActiveButton from "./NextActiveButton";
import { PaneTopBarWindowsOpener } from "./PaneTopBar";
import PrivacyModal from "./PrivacyModal";
import RailActions from "./RailActions";
import RailContext from "./RailContext";
import RailRadio from "./RailRadio";
import RecoverModal from "./RecoverModal";
import RegistrationWizardModal from "./RegistrationWizardModal";
import ResizeHandle from "./ResizeHandle";
import ScrollbackPane from "./ScrollbackPane";
import ServerReplyModal from "./ServerReplyModal";
import ServiceModal from "./ServiceModal";
import SettingsDrawer from "./SettingsDrawer";
import ShareSessionModal from "./ShareSessionModal";
import ShellChrome from "./ShellChrome";
import Sidebar from "./Sidebar";
import ThemeEditor from "./ThemeEditor";
import Toasts from "./Toasts";
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
// the mobile branch didn't render `.shell-sidebar` at all (channels
// live in BottomBar). The ShellChrome hamburger that toggled this
// signal is removed end-to-end — it duplicated TopicBar's members
// hamburger on mobile and toggled a no-op `.open` class on desktop.
//
// #1041 (2026-08-08) brings a left drawer BACK on mobile, but not the
// dropped shape: there is no hamburger and no always-mounted panel.
// The only door is the left-edge swipe, and the sidebar is mounted on
// the gesture and destroyed on hide (`sidebarMounted` / `sidebarSlidIn`
// below). BottomBar remains the primary channel nav — this is an
// additive second door, the same framing as #308 INC-A's right-edge
// swipe.
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

// #1041 — hard floor for the mobile sidebar's exit before it is disposed.
// Deliberately LONGER than the CSS `transition: transform 200ms` (default.css,
// `.shell-mobile .shell-sidebar`) rather than equal to it: `transitionend` is
// the primary dispose edge and this is only the backstop for the cases where it
// never fires (the element was never painted, or the transition was
// interrupted). Pinning the two to the same number would make a CSS tweak
// silently truncate the animation instead of merely shortening the slack.
const SIDEBAR_EXIT_FLOOR_MS = 400;

const Shell: Component = () => {
  const [membersOpen, setMembersOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // #1041 — the mobile left-edge swipe opens the channel sidebar, and that
  // sidebar is ABSENT from the DOM whenever it is not on screen: mounted when
  // the gesture commits, disposed at the end of the exit transition.
  //
  // Why unmount at all, when `.shell-members` (the right drawer) stays mounted
  // behind the edge: `Sidebar` owns no local state — zero createSignal /
  // createEffect / createMemo / onMount of its own — so a remount rebuilds it
  // identically from the same global stores, and nothing is lost. What
  // unmounting removes is not DOM nodes but the LIVE reactive subscriptions
  // (channelsBySlug, queryWindowsByNetwork, windowStateByChannel, the unread
  // badges…) that would otherwise re-run on every message on every network to
  // repaint something behind the left edge. That is the weight #1041 refuses to
  // add to the mobile app. It also sidesteps #782's failure mode on the right
  // drawer: an always-mounted pane needed an `onScreen` prop threaded in purely
  // to stop invisible work, and a prop can be forgotten — an absent component
  // cannot.
  //
  // TWO signals, deliberately out of phase at both ends. `sidebarMounted` gates
  // existence (the `<Show>`); `sidebarSlidIn` drives the `.open` transform.
  //   * ENTER: a node that mounts and gets `.open` in the same task never
  //     paints at `translateX(-100%)`, so the transition has no start value and
  //     the bar appears with no animation. Two rAFs buy one painted frame at
  //     the closed transform first.
  //   * EXIT: dropping the node the instant the class flips kills the exit
  //     animation, so disposal waits for the transform's `transitionend` — with
  //     SIDEBAR_EXIT_FLOOR_MS as the backstop, because that event does not fire
  //     for an unpainted or interrupted transition.
  const [sidebarMounted, setSidebarMounted] = createSignal(false);
  const [sidebarSlidIn, setSidebarSlidIn] = createSignal(false);
  let sidebarExitTimer: ReturnType<typeof setTimeout> | undefined;

  const disposeSidebar = (): void => {
    if (sidebarExitTimer !== undefined) {
      clearTimeout(sidebarExitTimer);
      sidebarExitTimer = undefined;
    }
    setSidebarMounted(false);
    setSidebarSlidIn(false);
  };

  const openSidebar = (): void => {
    if (sidebarExitTimer !== undefined) {
      clearTimeout(sidebarExitTimer);
      sidebarExitTimer = undefined;
    }
    setSidebarMounted(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // Re-check on the far side of two frames: a close that landed in the
        // meantime armed the exit timer, and sliding in now would flash the bar
        // open on its way out. An open→close→open inside those two frames
        // cleared the timer again, so this correctly slides in for the reopen.
        if (sidebarMounted() && sidebarExitTimer === undefined) setSidebarSlidIn(true);
      }),
    );
  };

  const closeSidebar = (): void => {
    if (!sidebarMounted()) return;
    setSidebarSlidIn(false);
    sidebarExitTimer = setTimeout(disposeSidebar, SIDEBAR_EXIT_FLOOR_MS);
  };

  onCleanup(() => {
    if (sidebarExitTimer !== undefined) clearTimeout(sidebarExitTimer);
  });

  // #1766 — the LEFT ☰, and the only reason it exists: turning the mobile
  // window bar off leaves #1041's left-edge swipe as the whole navigation
  // surface, and a gesture with zero affordance is the "drawer-only
  // navigation" #71's second ruling refused as a default. With the bar ON
  // there is already a picker in flow, so no door renders — a second one
  // nobody asked for is just chrome.
  //
  // Built ONCE and handed to both mobile hosts — the channel band's `leading`
  // slot and `.shell-chrome` — so the two surfaces cannot drift apart the way
  // #1073 found them drifted on the trailing side. It opens the SAME sidebar
  // the swipe opens (`openSidebar`, mount-on-demand + dispose-on-exit), not a
  // second panel: one door, two handles.
  const windowsRailOpener = (): JSX.Element => (
    <Show when={!getShowBottomBar()}>
      <PaneTopBarWindowsOpener onOpenWindows={openSidebar} />
    </Show>
  );

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
  // for members drawer, `.admin-pane` for admin window. Looked up via
  // querySelector after Solid commits the render (deferred a microtask
  // inside createOverlayLock).
  //
  // #608 — these two locks used to hand-roll the deferred push: they
  // popped synchronously on close but pushed a microtask later WITHOUT
  // re-checking the open edge. A same-tick open→close ran the pop
  // (clamped at 0) BEFORE the deferred push, stranding overlayCount()
  // at 1 for the session — which froze ScrollbackPane's overlay
  // snapshot (button hidden, no tail-follow, sends overwritten; cured
  // only by force-close). This is the stuck-scroll root cause. Routing
  // both through createOverlayLock fixes it: its deferred push
  // re-checks wasOpen + a `pushed` flag and skips a push whose overlay
  // already closed (the leak-safe pattern documented once in
  // overlayScrollLock.ts, and the same one every other modal already
  // uses). No onEscape — these are scroll-lock-only drawers that close
  // via the keybindings drawer fallback. The admin predicate reuses the
  // existing `isAdminPaneVisible` memo (derive, don't duplicate).
  createOverlayLock(
    () => isMobile() && membersOpen(),
    ".shell-mobile .shell-members .members-pane",
  );
  createOverlayLock(() => isMobile() && isAdminPaneVisible(), ".admin-pane");
  // #1041 — same treatment for the mobile left drawer: it is `position: fixed`
  // and owns its own scroll, so it needs the lock for its whole on-screen life.
  // Keyed on `sidebarMounted` rather than `sidebarSlidIn` so the lock survives
  // the exit transition, dropping only when the node actually goes away. No
  // onEscape — like the two above it is a scroll-lock-only drawer.
  createOverlayLock(() => isMobile() && sidebarMounted(), ".shell-mobile .shell-sidebar");

  // UX-4 bucket N — admin pane lifecycle is now selection-driven.
  // `selectedChannel.kind === "admin"` is the SINGLE source of truth
  // for the AdminPane mount (replacing the M-7 parallel `adminOpen`
  // signal). Triggers:
  //   * Sidebar admin row click (UX-4 bucket N — primary, always-
  //     visible affordance for admins).
  //   * RailActions 🔧 admin launcher (#473, reachable from every
  //     window kind on both form factors).
  // Both call setSelectedChannel({kind: "admin", ...ADMIN_*}).
  // #986 removed a THIRD trigger — the SettingsDrawer "admin console"
  // entry — as an exact duplicate of the rail one (same gate, same
  // payload, same destination), along with its `onOpenAdmin` prop.
  //
  // Visibility gate `isAdmin()` lives in `lib/networks.ts` — single
  // source of truth shared with RailActions (the 🔧 launcher) +
  // Sidebar (admin row). Pane mount further gates on `isAdmin()`
  // here so a stale selection (kind === "admin" persisted across
  // a demote) can't reach AdminPane content for a non-admin user.
  //
  // Demote-mid-session: when `me.is_admin` flips to false (another
  // admin demotes this operator, OR the bearer rotates to a
  // non-admin user), the createEffect below redirects selection
  // back to home if currently on admin. Sidebar admin row + the rail
  // 🔧 launcher vanish via the same `isAdmin()` predicate.

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
    // GH #359 — Alt+0. The status window is outside the Alt+1..9 index
    // space, so this is a distinct verb; the selection store owns which
    // network's status window it resolves to.
    selectStatusWindow: () => selectStatusWindow(),
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
      // #1067 extracted the append-focus-caret dance into `composeAppend` so
      // the reply quote and this off-compose keystroke share ONE verb.
      appendToCompose(sel.networkSlug, sel.channelName, char);
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
      //
      // #1113 — and reveal it: the completion can sit on any line of a draft
      // that wraps past the rows=1 textarea, above or below the visible box.
      queueMicrotask(() => {
        placeCaretInView(ta, result.newCursor);
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
    // #1883 — beside the TTL, and for the same reason: the very FIRST upload
    // must honour the saved preference, not only uploads made after the
    // settings drawer has been opened once.
    void loadUploadConfirmEnabled(t);
  });

  // #71 INC-2 — the "auto-close the members drawer on a non-joined-channel
  // selection" effect was REMOVED. R1 makes the right rail (this same
  // `.shell-members` drawer on mobile) a PERMANENT surface reachable from
  // EVERY window kind — the cog lives in it, so it MUST be openable on
  // non-channel windows (home/server/list/mentions/admin). Force-closing it
  // whenever `isActiveChannelJoined(...)` is false directly contradicts that. On
  // desktop the effect was already a visual no-op (the members pane is a grid
  // column; `membersOpen`/`.open` have no desktop CSS and the TopicBar
  // hamburger is CSS-hidden there, so membersOpen never toggled). The drawer
  // still closes via the opener toggle, the backdrop, the mutex helpers, and
  // MembersPane's onMemberSelect.

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
        const match = qs.find((q) =>
          nickEquals(q.targetNick, saved.channelName, casemappingForNetwork(net.id)),
        );
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
    <>
      <Show
        when={isMobile()}
        fallback={
          // ── Desktop three-pane layout (unchanged from pre-C6) ─────────
          <div
            class="shell"
            classList={{ "shell-no-members": !isActiveChannelJoined(selectedChannel()) }}
          >
            <ErrorBanners />
            <Toasts />
            <PrivacyModal />
            <MediaViewerModal />
            <NamesModal />
            <ThemeEditor />
            <WhoModal />
            <LinksModal />
            <ModeModal />
            <BanlistModal />
            <UmodeModal />
            <ServerReplyModal />
            <ServiceModal />
            <RegistrationWizardModal />
            <RecoverModal />
            <ShareSessionModal />
            {/* #1773 — the credits easter egg. Mounted here, not in the settings
              drawer that opens it: `.settings-drawer` animates on `transform`,
              which makes it the containing block for any `position: fixed`
              descendant, so a full-screen modal rendered from inside would be
              clipped to the drawer. Self-gated on `creditsModalOpen()`. */}
            <CreditsModal />
            <ConfirmModal />
            {/* #473 — ArchiveModal is the single archive surface on BOTH form
              factors. Mounted here on desktop (was mobile-only); the desktop
              Sidebar `<details class="sidebar-archive">` it replaces is
              removed. Self-gated on `archiveModalOpen()` — renders nothing
              when closed. Opened from the RailActions drawer archive button. */}
            <ArchiveModal />
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
              {/* #71 INC-2 (R1) — the always-present desktop ShellChrome row was
                REMOVED. Its settings cog moved into the permanent right rail
                (#473: the RailActions drawer mounted in `.shell-members` below),
                which is reachable from every window kind — so the "cog reachable
                from every window" rule the row used to satisfy now holds via the
                rail. Removing the row frees the top of `.shell-main` for the
                topic (the raised topic clamp, default.css). */}
              {/* #134 — the Switch fallback only renders when
                selectedChannel() is null, i.e. the cold-load window
                before the auto-select effect lands on $home. That IS the
                loading state, so the fallback is the retro CRT splash;
                CrtSplash self-gates on the same loading predicate and
                hands off (renders null) once load completes. */}
              <Switch fallback={<CrtSplash />}>
                <Match when={isAdminPaneVisible()}>
                  {/* UX-4 bucket N — AdminPane mount driven by selection +
                    isAdmin guard. #1073 deleted the pane's close × and its
                    `onClose` with it: selection is what unmounts this pane,
                    and the rail the ☰ opens already carries `home`. The
                    demote-redirect effect still lands on that same window. */}
                  <AdminPane
                    onOpenRail={() =>
                      toggleMembersPanel({ membersOpen, setMembersOpen, setSettingsOpen })
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
                  {/* #351 — the whole conversation pane is one drag-and-drop
                    file-upload target. DropUploadZone wraps the vertical
                    TopicBar + ScrollbackPane + ComposeBox stack; a file
                    dropped anywhere over it uploads via the SAME shared
                    `dropUpload` helper the compose box's paste path uses.
                    It's a transparent pass-through flex column, so the
                    scrollback still grows (flex:1) and compose keeps its
                    natural height — layout is unchanged. */}
                  <DropUploadZone
                    networkSlug={selectedChannel()?.networkSlug ?? ""}
                    channelName={selectedChannel()?.channelName ?? ""}
                  >
                    <Show when={selKind() === "channel"}>
                      <TopicBar
                        networkSlug={selectedChannel()?.networkSlug ?? ""}
                        channelName={selectedChannel()?.channelName ?? ""}
                        onToggleMembers={() => setMembersOpen((v) => !v)}
                        /* #1766 — desktop has a permanent sidebar, so there is
                         no window-list door to open and nothing to hide. The
                         band's ☰ is `display: none` up here anyway; passing
                         `null` means the button is never MOUNTED rather than
                         mounted-and-hidden. */
                        leading={null}
                      />
                    </Show>
                    <ScrollbackPane
                      networkSlug={selectedChannel()?.networkSlug ?? ""}
                      channelName={selectedChannel()?.channelName ?? ""}
                      kind={(selKind() as "channel" | "query" | "server") ?? "channel"}
                    />
                    <ComposeBox
                      networkSlug={selectedChannel()?.networkSlug ?? ""}
                      channelName={selectedChannel()?.channelName ?? ""}
                    />
                    {/* GH #115 — the docked audio mini-player's SLOT, BELOW
                      compose (#1701). #1896 turned the mount into a dock: the
                      player itself is mounted once below this <Show>, and only
                      its chrome is portalled in here, so neither a window
                      switch nor a rotation across 768px can tear the <audio>
                      element down. Still inside DropUploadZone, so #351's
                      whole-pane drop target keeps covering the strip. */}
                    <AudioDock />
                  </DropUploadZone>
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

            {/* #71 INC-2 (R1) — the right rail is now PERMANENT (decoupled from
              the members panel). `.shell-no-members` no longer drops this
              column; it narrows it to fit the rail buttons (default.css), so
              they are reachable on every window kind. #473 — MembersPane is
              conditional content at the top; the RailActions drawer (all the
              labelled buttons) floors at the bottom. */}
            <aside class="shell-members" classList={{ open: membersOpen() }}>
              {/* UX-5 bucket BS — drag handle on the inner edge of the
                right (members) sidebar. Mounted unconditionally even
                when isActiveChannelJoined(...) is false (the column
                narrows via .shell-no-members in CSS); the handle is
                inside the aside so it's hidden together. */}
              <ResizeHandle side="right" />
              <Show when={isActiveChannelJoined(selectedChannel()) && selectedChannel()}>
                {(sel) => (
                  <MembersPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
                )}
              </Show>
              {/* #474 — the per-window-kind rail context surface (server info
                today; a /whois card is the deferred follow-on), grafted as a
                SIBLING of the drawer below. Renders nothing on kinds with no
                context, so the drawer still floors the rail.
                #782 — `onScreen` is unconditionally true here: this rail is a
                PERMANENT grid column (#71 INC-2, `.shell-no-members` narrows
                it but never drops it), and a query window renders no
                MembersPane above the card, so it cannot be scrolled out of
                view either. */}
              <RailContext onScreen={true} />
              {/* #473 — the ONE unified rail action drawer, floored at the bottom
                (CSS `.rail-actions { margin-top: auto }`). Supersedes the desktop
                top ActionCluster (cog + denoise) and, crucially, brings the
                window-nav launchers (home / rooms / themes / admin) the desktop
                rail never had — the desktop rail was "a cog and a monkey" (#473).
                The mobile drawer mounts the SAME component (below). Archive is
                now a first-class always-on RailActions button opening the single
                grouped ArchiveModal (mounted above) — the desktop Sidebar
                `<details>` and the mobile footer chip it replaced are removed. */}
              {/* #682 — the radio surface, mounted UNCONDITIONALLY like the drawer
              below it and deliberately NOT as a `RailContext` arm: that
              component grafts by the active window's KIND and would drop the
              panel the moment the operator switched to a query. Idle it renders
              nothing at all, so #500's vertical budget is untouched until a
              station is tuned; its picker overlays the whole rail. */}
              <RailRadio />
              <RailActions setters={{ membersOpen, setMembersOpen, setSettingsOpen }} />
            </aside>

            <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
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
          Channel sidebar (.shell-sidebar) is not part of this layout —
          channels are navigated via BottomBar. This is a full JSX branch,
          not a CSS-display toggle, so the sidebar DOM is absent entirely.
          #1041 mounts it TRANSIENTLY below, as a `position: fixed` left
          drawer that exists only while the left-edge swipe has it on
          screen: it never takes a grid track and it is gone again the
          moment it hides, so "absent unless on screen" still holds.
      */}
        <div
          class="shell shell-mobile"
          // #308 INC-A — right-edge swipe (right→center) opens the members drawer;
          // #1041 — left-edge swipe (left→center) opens the channel sidebar. Both
          // are ADDITIVE second doors onto a rail (the BottomBar stays the primary
          // nav — #71 ruling). Bound at element level with a non-passive touchmove
          // + explicit onCleanup (Solid delegates touch to a passive document
          // listener, and function refs are not re-invoked at unmount — #308
          // landmines 1 + 3). Claims late, so a vertical drag is left entirely to
          // native scroll (the hard constraint). Mobile-only: the ref lives in the
          // isMobile() JSX branch, so it attaches only here.
          ref={(el) =>
            onCleanup(
              bindEdgeGesture(el, {
                viewportWidth: () => window.innerWidth,
                // #1041 — the sidebar joins the panel mutex from THIS side, at the
                // call site. Once a left drawer can be up, its backdrop is a child
                // of `.shell-mobile`, so a right-edge touch that lands on it
                // bubbles here and arms this arm with the other drawer still on
                // screen. Honour the gesture and retire the sidebar rather than
                // refuse it (the left arm's posture): a pull toward the members
                // rail means "show me the members", and a silently dropped
                // directional gesture is the surprising reading. `closeSidebar` is
                // a no-op when nothing is mounted, so the plain #308 case is
                // untouched. It runs FIRST so both animations start on the same
                // frame — one drawer leaves as the other arrives.
                onOpenMembers: () => {
                  closeSidebar();
                  openMembersPanel({ membersOpen, setMembersOpen, setSettingsOpen });
                },
                // #1041 — refuse the gesture while ANY overlay is up rather than
                // teaching the mobilePanel mutex a fourth member. A backdrop or a
                // modal is a child of `.shell-mobile`, so its touches still bubble
                // to this listener and a left swipe would otherwise stack a second
                // drawer under an open one. `overlayCount()` is the state that
                // already answers "is something covering the shell" for every
                // present AND future overlay — derive it, don't mirror it. Read
                // outside a tracking scope, so this subscribes to nothing.
                // The asymmetry with the members arm above is deliberate: that arm
                // faces ONE sibling drawer it can retire, this one faces every
                // modal in the shell — and "close whatever is covering me" is not
                // a swipe's decision to make.
                onOpenSidebar: () => {
                  if (overlayCount() > 0) return;
                  openSidebar();
                },
              }),
            )
          }
        >
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
          <Toasts />
          <PrivacyModal />
          <MediaViewerModal />
          <NamesModal />
          <ThemeEditor />
          <WhoModal />
          <LinksModal />
          <UmodeModal />
          <ModeModal />
          <BanlistModal />
          <ServerReplyModal />
          <ServiceModal />
          <RegistrationWizardModal />
          <RecoverModal />
          <ShareSessionModal />
          {/* #1773 — see the desktop branch above for why it is mounted here. */}
          <CreditsModal />
          <ConfirmModal />
          <Show when={membersOpen()}>
            <div
              class="shell-drawer-backdrop open"
              onClick={() => setMembersOpen(false)}
              aria-hidden="true"
            />
          </Show>

          <section class="shell-main">
            {/* Mobile-non-channel windows (home / mentions / admin / server /
              list) render the standalone .shell-chrome row. #71 INC-2 (R1):
              its settings cog became the ☰ RAIL OPENER — the cog itself moved
              into the rail (#473: the `.shell-members` drawer's RailActions).
              This is the opener for non-channel windows (channel windows open the
              same drawer via the TopicBar hamburger — ONE drawer, one ☰ glyph,
              per the Opt-A ruling). Mobile-channel still suppresses this row so
              the scrollback reclaims the ~32px. Earlier history of this surface
              in the bucket commits (UX-4 L, UX-5 A, UX-5 BT, UX-5 BM). */}
            {/* Admin redesign (2026-08-07) — the admin kind is excluded too. The
              row would hold nothing but the ☰ and sit directly above the pane's
              own "admin console" header: two chrome bands for one title on a
              phone. AdminPane renders the SAME `RailOpenerButton` inline in that
              header instead, so the opener stays reachable on the admin window
              (bucket L, asserted in ux-4-z-cluster-journey) and the testid stays
              singular — the two mounts are mutually exclusive by this gate. */}
            {/* #1050 — `list` is the third exclusion, for the same collision the
              admin note above describes but with the opposite remedy. The
              directory pane's close ✕ is the LAST child of its header, i.e. the
              top-right corner the #985 float lands in at z-index 41, so the ☰
              won the hit test and the tap that should leave the directory
              opened the rail instead. Admin re-homed the button into its own
              pane header; here the owner's call is that this window does not
              want the rail at all, so the row simply goes. Bucket L ("settings
              reachable from every window kind") is knowingly relaxed for this
              ONE kind — every other non-channel kind keeps the float. Whole-row
              and not a `display: none` on the glyph: the row is what carries
              the z-index, and its zero-height box would stay over the header.
              Reads `selKind()` — the same memo the mobile `<Match>` below
              switches on — rather than re-deriving the kind here. */}
            <Show when={selKind() !== "channel" && selKind() !== "list" && !isAdminPaneVisible()}>
              <ShellChrome
                leading={windowsRailOpener()}
                onOpenRail={() =>
                  toggleMembersPanel({ membersOpen, setMembersOpen, setSettingsOpen })
                }
              />
            </Show>
            {/* #134 — CRT loading splash (mobile). Same loading-only
              contract as desktop: the fallback is the cold-load state. */}
            <Switch fallback={<CrtSplash />}>
              <Match when={isAdminPaneVisible()}>
                <AdminPane
                  onOpenRail={() =>
                    toggleMembersPanel({ membersOpen, setMembersOpen, setSettingsOpen })
                  }
                />
              </Match>
              <Match when={kindHasScrollback(selKind())}>
                {/* BUGHUNT-3 D — channel + query + server share ONE Match
                  so ScrollbackPane stays mounted across kind transitions.
                  See desktop branch comment for details. */}
                {/* #351 — whole-pane drag-and-drop upload target (mobile).
                  Same DropUploadZone wrapper as desktop; see that branch's
                  comment. It wraps the channel-gated TopicBar Show plus the
                  scrollback + compose stack, so a drop over the topic header,
                  the scrollback, or the compose strip all upload identically. */}
                <DropUploadZone
                  networkSlug={selectedChannel()?.networkSlug ?? ""}
                  channelName={selectedChannel()?.channelName ?? ""}
                >
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
                      leading={windowsRailOpener()}
                    />
                  </Show>
                  <ScrollbackPane
                    networkSlug={selectedChannel()?.networkSlug ?? ""}
                    channelName={selectedChannel()?.channelName ?? ""}
                    kind={(selKind() as "channel" | "query" | "server") ?? "channel"}
                  />
                  <ComposeBox
                    networkSlug={selectedChannel()?.networkSlug ?? ""}
                    channelName={selectedChannel()?.channelName ?? ""}
                  />
                  {/* GH #115 — the docked audio mini-player's SLOT. #1701 moved
                    it BELOW compose, so on mobile it lands between the compose
                    box and the BottomBar (a sibling of `.shell-main`, further
                    down). #1896 — a dock, not a mount: see the desktop arm. */}
                  <AudioDock />
                </DropUploadZone>
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

          {/* #1766 — the window bar is opt-OUT (default shown). A MOUNT gate and
            not `display: none`: BottomBar carries no internal display guard by
            design, and a CSS-hidden bar would keep running #327's double-rAF
            scroll-into-view work against a strip nobody can see. Turning it
            off is survivable because #1041's left-edge swipe exists — and
            because `windowsRailOpener()` above gives that swipe an
            affordance, which is what keeps this short of the drawer-only
            navigation #71's second ruling refused. */}
          <Show when={getShowBottomBar()}>
            <BottomBar />
          </Show>

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

          {/* #473 — ArchiveModal is the single archive surface on BOTH form
            factors (also mounted in the desktop branch above). Opened from the
            RailActions drawer archive button; self-gated on `archiveModalOpen()`
            — renders nothing when closed. */}
          <ArchiveModal />

          {/* #1041 — the mobile channel sidebar, opened by the left-edge swipe.
            Its own backdrop instance (the members drawer above has a separate
            one): each drawer owns the surface that dismisses IT, so a tap can
            never close the wrong one. Rendered only while the sidebar exists,
            and it fades on the same 200ms as the panel. */}
          <Show when={sidebarMounted()}>
            <div
              class="shell-drawer-backdrop"
              classList={{ open: sidebarSlidIn() }}
              onClick={closeSidebar}
              aria-hidden="true"
            />
            {/* Same `.shell-sidebar` element the desktop grid mounts — the mobile
              @media block turns it into a fixed left drawer. `<Sidebar />` is
              mounted BARE here: NextActiveButton already has a mobile variant
              elsewhere in this branch, and ResizeHandle is desktop-only.
              #1041 restores Sidebar's `onSelect` prop, dropped in UX-5 bucket A
              on the grounds that no drawer was left to close — a premise this
              issue expires. Picking a window dismisses the drawer; the prop
              fires on EVERY row activation, including a re-tap of the already
              selected row (which a selection-watching effect would miss). */}
            <aside
              class="shell-sidebar"
              classList={{ open: sidebarSlidIn() }}
              onTransitionEnd={(e) => {
                // Dispose at the END of the exit slide, never at the class flip.
                // Descendants bubble their own transitions through here, hence
                // the target check; the timer in closeSidebar covers the case
                // where this never fires at all.
                if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
                if (!sidebarSlidIn()) disposeSidebar();
              }}
            >
              <Sidebar onSelect={closeSidebar} />
            </aside>
          </Show>

          {/* #473 — the mobile members drawer IS the right rail, reachable on
            EVERY window (channel: TopicBar ☰; non-channel: ShellChrome ☰ above —
            ONE drawer). It mounts the SAME `RailActions` drawer as the desktop
            rail: the post-#71 split (top ActionCluster cog + denoise, plus the
            old footer's window-nav launchers AND its archive chip) folds into
            ONE bottom drawer. The mobile-only `.mobile-panel-actions` footer is
            gone — archive is now a first-class RailActions button. */}
          <aside class="shell-members" classList={{ open: membersOpen() }}>
            <Show when={isActiveChannelJoined(selectedChannel()) && selectedChannel()}>
              {(sel) => (
                <MembersPane
                  networkSlug={sel().networkSlug}
                  channelName={sel().channelName}
                  onMemberSelect={() => setMembersOpen(false)}
                />
              )}
            </Show>
            {/* #474 — per-window-kind rail context (server info today), grafted
              as a SIBLING of the drawer below; renders nothing off a server
              window. Same component the desktop rail mounts.
              #782 — this drawer is MOUNTED whether open or shut (closed is
              `transform: translateX(100%)`, not an unmount), so `membersOpen`
              is the only honest answer to "is the card on screen": without it
              every mobile session would spend a WHOIS on a card behind the
              right edge. */}
            <RailContext onScreen={membersOpen()} />
            {/* #473 — the ONE unified rail action drawer, floored at the bottom.
              Same component + same handler set the desktop rail mounts (the
              drawer-closing arm of the mobilePanel helpers is meaningful here on
              mobile and a harmless no-op on the permanent desktop rail). */}
            {/* #682 — the radio surface, mounted UNCONDITIONALLY like the drawer
              below it and deliberately NOT as a `RailContext` arm: that
              component grafts by the active window's KIND and would drop the
              panel the moment the operator switched to a query. Idle it renders
              nothing at all, so #500's vertical budget is untouched until a
              station is tuned; its picker overlays the whole rail. */}
            <RailRadio />
            <RailActions setters={{ membersOpen, setMembersOpen, setSettingsOpen }} />
          </aside>

          <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
        </div>
      </Show>

      {/* GH #115 / #1896 — THE player, mounted once, OUTSIDE the regime branch.
          The two arms above are a JSX split and not a CSS toggle, so a phone
          crossing 768px on rotation destroys one whole subtree and builds the
          other: a player mounted inside an arm came back as a NEW <audio>
          element, which for a stream means re-tuning — a new HTTP connection,
          heard as a gap and a restart. Mounted here it is untouched by the
          flip, and its chrome travels to whichever <AudioDock /> is live.
          AFTER the <Show> on purpose: the branch (and therefore its dock) is
          built first, so the player finds a dock on its very first render
          instead of docking a tick later. */}
      <AudioMiniPlayer />
    </>
  );
};

export default Shell;
