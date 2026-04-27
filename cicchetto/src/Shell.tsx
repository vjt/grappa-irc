import { useNavigate } from "@solidjs/router";
import { type Component, For, Show } from "solid-js";
import * as auth from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import {
  channelsBySlug,
  networks,
  selectedChannel,
  setSelectedChannel,
  unreadCounts,
  user,
} from "./lib/networks";
import ScrollbackPane from "./ScrollbackPane";

// Logged-in landing surface. Sub-task 4 wires the network → channel
// sidebar + the live-event WS subscription that drives unread counts;
// the right pane is the placeholder for sub-task 5's scrollback +
// compose. The /me + /networks fetches and the per-channel topic joins
// all live in `lib/networks.ts` — Shell is a pure read-side
// projection of those signals.
const Shell: Component = () => {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await auth.logout();
    navigate("/login", { replace: true });
  };

  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  return (
    <main class="shell-app">
      <header class="shell-header">
        <Show when={user()} fallback={<span class="muted">loading…</span>}>
          {(u) => <span>logged in as {u().name}</span>}
        </Show>
        <button type="button" onClick={handleLogout}>
          log out
        </button>
      </header>
      <div class="shell-body">
        <aside class="sidebar">
          <Show
            when={(networks()?.length ?? 0) > 0}
            fallback={<p class="muted sidebar-empty">no networks</p>}
          >
            <For each={networks()}>
              {(network) => (
                <section class="network">
                  <h3>{network.slug}</h3>
                  <ul>
                    <For each={channelsBySlug()?.[network.slug] ?? []}>
                      {(channel) => {
                        const key = channelKey(network.slug, channel.name);
                        return (
                          <li classList={{ selected: isSelected(network.slug, channel.name) }}>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedChannel({
                                  networkSlug: network.slug,
                                  channelName: channel.name,
                                })
                              }
                            >
                              <span class="channel-name">{channel.name}</span>
                              <Show when={(unreadCounts()[key] ?? 0) > 0}>
                                <span class="unread">{unreadCounts()[key]}</span>
                              </Show>
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </aside>
        <section class="pane">
          <Show
            when={selectedChannel()}
            fallback={<p class="muted">select a channel to view scrollback</p>}
          >
            {(sel) => (
              <ScrollbackPane networkSlug={sel().networkSlug} channelName={sel().channelName} />
            )}
          </Show>
        </section>
      </div>
    </main>
  );
};

export default Shell;
