import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import ComposeBox from "./ComposeBox";
import { channelKey } from "./lib/channelKey";
import { getDraft, setDraft, tabComplete } from "./lib/compose";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { channelsBySlug, networks } from "./lib/networks";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";
import MembersPane from "./MembersPane";
import ScrollbackPane from "./ScrollbackPane";
import SettingsDrawer from "./SettingsDrawer";
import Sidebar from "./Sidebar";
import TopicBar from "./TopicBar";

// Three-pane responsive shell. Composition root for Sidebar / TopicBar /
// ScrollbackPane / ComposeBox / MembersPane / SettingsDrawer.
//
// Drawer state (mobile, ≤768px) lives here:
//   * sidebarOpen — left channel-list drawer
//   * membersOpen — right members-list drawer
//   * settingsOpen — full-cover settings overlay (desktop+mobile)
//
// Keybindings: Shell is the only consumer of `keybindings.registerHandlers`
// + `install`. Action callbacks drive selection (Alt+1..9, Ctrl+N/P),
// drawer state (Esc), compose focus (/), and tab-complete (Tab in
// compose textarea). install() is idempotent; uninstall fires on unmount.
//
// Mobile layout follows from CSS media queries against
// `--breakpoint-mobile: 768px`. Same DOM in both layouts; only display +
// transform change. The .open classList drives the slide-in transition.

const Shell: Component = () => {
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

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
      if (target) setSelectedChannel({ networkSlug: target.slug, channelName: target.name });
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
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name });
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
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name });
          return;
        }
      }
    },
    focusCompose: () => {
      const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
      ta?.focus();
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

  // Auto-close sidebar drawer when the user picks a channel (mobile UX).
  // `defer: true` skips the initial run so we don't immediately close
  // a drawer the user just opened with the default selection.
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
              <TopicBar
                networkSlug={sel().networkSlug}
                channelName={sel().channelName}
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                onToggleMembers={() => setMembersOpen((v) => !v)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
              <ScrollbackPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
              <ComposeBox networkSlug={sel().networkSlug} channelName={sel().channelName} />
            </>
          )}
        </Show>
      </section>

      <aside class="shell-members" classList={{ open: membersOpen() }}>
        <Show when={selectedChannel()}>
          {(sel) => <MembersPane networkSlug={sel().networkSlug} channelName={sel().channelName} />}
        </Show>
      </aside>

      <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};

export default Shell;
