import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import BottomBar from "./BottomBar";
import ComposeBox from "./ComposeBox";
import { displayNick } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { getDraft, setDraft, tabComplete } from "./lib/compose";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { channelsBySlug, networks, user } from "./lib/networks";
import { setReadCursor } from "./lib/readCursor";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";
import { isMobile } from "./lib/theme";
import MembersPane from "./MembersPane";
import MentionsWindow from "./MentionsWindow";
import ScrollbackPane from "./ScrollbackPane";
import SettingsDrawer from "./SettingsDrawer";
import Sidebar from "./Sidebar";
import TopicBar from "./TopicBar";

// Three-pane responsive shell. Composition root for Sidebar / TopicBar /
// ScrollbackPane / ComposeBox / MembersPane / SettingsDrawer / BottomBar.
//
// Drawer state lives here:
//   * sidebarOpen — left channel-list drawer (desktop only; on mobile, channels
//     live in BottomBar and the sidebar is not rendered at all)
//   * membersOpen — right members-list drawer (desktop + mobile via single hamburger)
//   * settingsOpen — full-cover settings overlay (desktop+mobile)
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
//
// The sidebar auto-close effect fires on both branches. On mobile, it is a
// harmless no-op: setSidebarOpen(false) writes a signal whose DOM node is
// not rendered in the mobile branch.

const Shell: Component = () => {
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Own-nick derived from the authenticated user. Used by MentionsWindow
  // to highlight rows where the body matches the operator's nick.
  const ownNick = (): string | null => {
    const u = user();
    return u ? displayNick(u) : null;
  };

  // C8.2 — click-to-context handler for MentionsWindow rows.
  // Sets read cursor to serverTime-1 so ScrollbackPane's unread-marker
  // appears just before the clicked message, then switches focus to the
  // source channel. The existing C7.3 scroll-to-marker infrastructure in
  // ScrollbackPane handles the visual scroll.
  const handleMentionClicked = (args: {
    networkSlug: string;
    channel: string;
    serverTime: number;
  }) => {
    setReadCursor(args.networkSlug, args.channel, args.serverTime - 1);
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
      setSidebarOpen(false);
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

  // Auto-close sidebar drawer when the user picks a channel.
  // `defer: true` skips the initial run so we don't immediately close
  // a drawer the user just opened with the default selection.
  // On mobile this is a harmless no-op: setSidebarOpen(false) writes to
  // a signal whose corresponding DOM node is not rendered.
  createEffect(
    on(
      selectedChannel,
      () => {
        setSidebarOpen(false);
      },
      { defer: true },
    ),
  );

  return (
    <Show
      when={isMobile()}
      fallback={
        // ── Desktop three-pane layout (unchanged from pre-C6) ─────────
        <div class="shell">
          <aside class="shell-sidebar" classList={{ open: sidebarOpen() }}>
            <Sidebar onSelect={() => setSidebarOpen(false)} />
          </aside>

          <Show when={sidebarOpen() || membersOpen()}>
            <div
              class="shell-drawer-backdrop open"
              onClick={() => {
                setSidebarOpen(false);
                setMembersOpen(false);
              }}
              aria-hidden="true"
            />
          </Show>

          <section class="shell-main">
            <Show
              when={selectedChannel()}
              fallback={
                <>
                  <header class="shell-empty-toolbar">
                    <button
                      type="button"
                      class="topic-bar-hamburger"
                      aria-label="open channel sidebar"
                      onClick={() => setSidebarOpen((v) => !v)}
                    >
                      ☰
                    </button>
                    <span class="shell-empty-toolbar-spacer" />
                    <button
                      type="button"
                      class="topic-bar-settings"
                      aria-label="open settings"
                      onClick={() => setSettingsOpen(true)}
                    >
                      ⚙
                    </button>
                  </header>
                  <p class="muted">select a channel to view scrollback</p>
                </>
              }
            >
              {(sel) => (
                <>
                  <Show when={sel().kind === "channel"}>
                    <TopicBar
                      networkSlug={sel().networkSlug}
                      channelName={sel().channelName}
                      onToggleSidebar={() => setSidebarOpen((v) => !v)}
                      onToggleMembers={() => setMembersOpen((v) => !v)}
                      onOpenSettings={() => setSettingsOpen(true)}
                    />
                  </Show>
                  <Show
                    when={sel().kind === "mentions"}
                    fallback={
                      <>
                        <ScrollbackPane
                          networkSlug={sel().networkSlug}
                          channelName={sel().channelName}
                          kind={sel().kind}
                        />
                        {/* Server window is read-only — no compose box (BUG 2d fix). */}
                        <Show when={sel().kind !== "server"}>
                          <ComposeBox
                            networkSlug={sel().networkSlug}
                            channelName={sel().channelName}
                          />
                        </Show>
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
                      ownNick={ownNick()}
                      onMentionClicked={handleMentionClicked}
                    />
                  </Show>
                </>
              )}
            </Show>
          </section>

          <aside class="shell-members" classList={{ open: membersOpen() }}>
            <Show when={selectedChannel()}>
              {(sel) => (
                <MembersPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
              )}
            </Show>
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
          Channel sidebar (.shell-sidebar) is NOT rendered on mobile —
          channels are navigated via BottomBar. This is a full JSX branch,
          not a CSS-display toggle, so the sidebar DOM is absent entirely.
      */}
      <div class="shell shell-mobile">
        <Show when={membersOpen()}>
          <div
            class="shell-drawer-backdrop open"
            onClick={() => setMembersOpen(false)}
            aria-hidden="true"
          />
        </Show>

        <section class="shell-main">
          <Show
            when={selectedChannel()}
            fallback={
              <>
                <header class="shell-empty-toolbar">
                  <span class="shell-empty-toolbar-spacer" />
                  <button
                    type="button"
                    class="topic-bar-settings"
                    aria-label="open settings"
                    onClick={() => setSettingsOpen(true)}
                  >
                    ⚙
                  </button>
                </header>
                <p class="muted">select a channel below</p>
              </>
            }
          >
            {(sel) => (
              <>
                <Show when={sel().kind === "channel"}>
                  {/* C6.3: on mobile, TopicBar is given onToggleSidebar as no-op
                      (channel sidebar doesn't exist on mobile) and onToggleMembers
                      as the single hamburger. TopicBar hides the sidebar hamburger
                      on mobile via isMobile() gating inside TopicBar itself. */}
                  <TopicBar
                    networkSlug={sel().networkSlug}
                    channelName={sel().channelName}
                    onToggleSidebar={() => undefined}
                    onToggleMembers={() => setMembersOpen((v) => !v)}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                </Show>
                <Show
                  when={sel().kind === "mentions"}
                  fallback={
                    <>
                      <ScrollbackPane
                        networkSlug={sel().networkSlug}
                        channelName={sel().channelName}
                        kind={sel().kind}
                      />
                      {/* Server window is read-only — no compose box (BUG 2d fix). */}
                      <Show when={sel().kind !== "server"}>
                        <ComposeBox
                          networkSlug={sel().networkSlug}
                          channelName={sel().channelName}
                        />
                      </Show>
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
                    ownNick={ownNick()}
                    onMentionClicked={handleMentionClicked}
                  />
                </Show>
              </>
            )}
          </Show>
        </section>

        <BottomBar />

        <aside class="shell-members" classList={{ open: membersOpen() }}>
          <Show when={selectedChannel()}>
            {(sel) => (
              <MembersPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
            )}
          </Show>
        </aside>

        <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      </div>
    </Show>
  );
};

export default Shell;
