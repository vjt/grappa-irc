import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { logout, token } from "./lib/auth";
import {
  disablePush,
  type EnablePushResult,
  enablePush,
  listPushDevices,
  type PushDeviceSummary,
} from "./lib/push";
import { getTheme, setTheme, type ThemePref } from "./lib/theme";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  type NotificationPrefs,
  putNotificationPrefs,
} from "./lib/userSettings";

// Right-overlay drawer: theme toggle + notifications (push permission +
// per-trigger prefs + device list) + logout.
//
// open prop drives the .open class; the drawer stays mounted across
// open/close so onMount-loaded state (devices + prefs) doesn't refetch
// per open. Backdrop click fires onClose; Esc handled in Shell.tsx.

export type Props = {
  open: boolean;
  onClose: () => void;
};

const SettingsDrawer: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [pref, setPref] = createSignal<ThemePref>(getTheme());

  const [prefs, setPrefs] = createSignal<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [devices, setDevices] = createSignal<PushDeviceSummary[]>([]);
  const [pushEnabled, setPushEnabled] = createSignal(false);
  const [pushBanner, setPushBanner] = createSignal<string | null>(null);
  const [savingPrefs, setSavingPrefs] = createSignal(false);
  const [prefsError, setPrefsError] = createSignal<string | null>(null);
  // Comma-separated UI shadows for the two whitelist text inputs — the
  // server stores normalized lists; cic edits are joined with ", " and
  // re-split on PUT so partial typing doesn't drop characters.
  const [channelsOnlyText, setChannelsOnlyText] = createSignal("");
  const [nicksOnlyText, setNicksOnlyText] = createSignal("");

  const onChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as ThemePref;
    setPref(value);
    setTheme(value);
  };

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const refreshDevices = async () => {
    const t = token();
    if (t === null) return;
    try {
      const list = await listPushDevices(t);
      setDevices(list);
    } catch {
      /* swallowed — device list is informational */
    }
  };

  const refreshPrefs = async () => {
    const t = token();
    if (t === null) return;
    try {
      const loaded = await getNotificationPrefs(t);
      setPrefs(loaded);
      setChannelsOnlyText(loaded.channel_messages_only.join(", "));
      setNicksOnlyText(loaded.private_messages_only.join(", "));
    } catch {
      /* swallowed — fall back to defaults */
    }
  };

  // Load prefs + devices once at mount + probe the SW for an actual
  // PushSubscription. Notification.permission alone is NOT proof of a
  // live subscription on THIS browser profile — the user may have
  // granted permission in another profile / cleared site data /
  // unsubscribed via DevTools. Source of truth: the SW's
  // `pushManager.getSubscription()`. We reflect THAT into pushEnabled.
  onMount(() => {
    void refreshPrefs();
    void refreshDevices();
    void probeLocalSubscription();
  });

  const probeLocalSubscription = async () => {
    if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration.pushManager === undefined) return;
      const sub = await registration.pushManager.getSubscription();
      setPushEnabled(sub !== null);
    } catch {
      /* swallowed — pushEnabled stays false */
    }
  };

  const splitCsv = (s: string): string[] =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");

  const savePrefs = async (next: NotificationPrefs) => {
    const t = token();
    if (t === null) return;
    setSavingPrefs(true);
    setPrefsError(null);
    try {
      const saved = await putNotificationPrefs(t, next);
      setPrefs(saved);
    } catch (err) {
      const code = err instanceof Error ? err.message : "save_failed";
      setPrefsError(code);
    } finally {
      setSavingPrefs(false);
    }
  };

  const togglePref = (key: keyof NotificationPrefs, checked: boolean) => {
    const current = prefs();
    if (typeof current[key] !== "boolean") return;
    void savePrefs({ ...current, [key]: checked });
  };

  const commitChannelsOnly = () => {
    const next = { ...prefs(), channel_messages_only: splitCsv(channelsOnlyText()) };
    void savePrefs(next);
  };

  const commitNicksOnly = () => {
    const next = { ...prefs(), private_messages_only: splitCsv(nicksOnlyText()) };
    void savePrefs(next);
  };

  const onMasterToggle = async (checked: boolean) => {
    const t = token();
    if (t === null) return;
    setPushBanner(null);
    if (checked) {
      const result: EnablePushResult = await enablePush(t);
      if (result.status === "enabled") {
        setPushEnabled(true);
        await refreshDevices();
      } else if (result.status === "permission_denied") {
        setPushEnabled(false);
        setPushBanner(
          "Browser notifications are blocked. Open your browser site settings, allow notifications for this site, then try again.",
        );
      } else if (result.status === "permission_dismissed") {
        setPushEnabled(false);
        setPushBanner("Permission prompt dismissed. Toggle again to re-prompt.");
      } else {
        setPushEnabled(false);
        setPushBanner(
          "Push notifications are not supported in this browser. Install Cicchetto to your home screen for the best experience.",
        );
      }
    } else {
      await disablePush(t);
      setPushEnabled(false);
      await refreshDevices();
    }
  };

  const removeDevice = async (id: string) => {
    const t = token();
    if (t === null) return;
    const { deletePushSubscription } = await import("./lib/push");
    try {
      await deletePushSubscription(t, id);
      await refreshDevices();
    } catch {
      /* swallowed — UI will refresh on next drawer open */
    }
  };

  return (
    <>
      <div
        class="settings-drawer-backdrop"
        classList={{ open: props.open }}
        onClick={props.onClose}
        aria-hidden="true"
        data-testid="settings-drawer-backdrop"
      />
      <aside
        class="settings-drawer"
        classList={{ open: props.open }}
        role="dialog"
        aria-label="settings"
      >
        <h2>settings</h2>
        <fieldset>
          <legend>theme</legend>
          <label>
            <input
              type="radio"
              name="theme"
              value="auto"
              checked={pref() === "auto"}
              onChange={onChange}
            />
            auto (follow system)
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="mirc-light"
              checked={pref() === "mirc-light"}
              onChange={onChange}
            />
            mIRC light
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="irssi-dark"
              checked={pref() === "irssi-dark"}
              onChange={onChange}
            />
            irssi dark
          </label>
        </fieldset>

        <fieldset class="notifications-fieldset">
          <legend>notifications</legend>
          <label class="master-toggle">
            <input
              type="checkbox"
              checked={pushEnabled()}
              onChange={(e) => {
                void onMasterToggle((e.currentTarget as HTMLInputElement).checked);
              }}
              data-testid="push-master-toggle"
            />
            enable browser notifications
          </label>
          <Show when={pushBanner() !== null}>
            <p class="push-banner" role="alert" data-testid="push-banner">
              {pushBanner()}
            </p>
          </Show>

          <hr />

          <label>
            <input
              type="checkbox"
              checked={prefs().channel_messages_all}
              disabled={savingPrefs()}
              onChange={(e) =>
                togglePref("channel_messages_all", (e.currentTarget as HTMLInputElement).checked)
              }
              data-testid="pref-channel-all"
            />
            all channel messages
          </label>
          <label class="prefs-list">
            only in channels:
            <input
              type="text"
              value={channelsOnlyText()}
              disabled={prefs().channel_messages_all || savingPrefs()}
              placeholder="#sbiffo, #grappa"
              onInput={(e) => setChannelsOnlyText((e.currentTarget as HTMLInputElement).value)}
              onBlur={commitChannelsOnly}
              data-testid="pref-channels-only"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs().channel_mentions}
              disabled={savingPrefs()}
              onChange={(e) =>
                togglePref("channel_mentions", (e.currentTarget as HTMLInputElement).checked)
              }
              data-testid="pref-channel-mentions"
            />
            channel mentions
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs().private_messages_all}
              disabled={savingPrefs()}
              onChange={(e) =>
                togglePref("private_messages_all", (e.currentTarget as HTMLInputElement).checked)
              }
              data-testid="pref-private-all"
            />
            all private messages
          </label>
          <label class="prefs-list">
            only from nicks:
            <input
              type="text"
              value={nicksOnlyText()}
              disabled={prefs().private_messages_all || savingPrefs()}
              placeholder="alice, bob"
              onInput={(e) => setNicksOnlyText((e.currentTarget as HTMLInputElement).value)}
              onBlur={commitNicksOnly}
              data-testid="pref-nicks-only"
            />
          </label>

          <Show when={prefsError() !== null}>
            <p class="prefs-error" role="alert" data-testid="prefs-error">
              {prefsError()}
            </p>
          </Show>

          <Show when={devices().length > 0}>
            <h3>devices</h3>
            <ul class="devices-list" data-testid="devices-list">
              <For each={devices()}>
                {(d) => (
                  <li>
                    <span class="device-ua">{d.user_agent ?? "(unknown browser)"}</span>
                    <button
                      type="button"
                      class="device-remove"
                      onClick={() => {
                        void removeDevice(d.id);
                      }}
                    >
                      remove
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </fieldset>

        <button
          type="button"
          class="logout"
          onClick={() => {
            void onLogout();
          }}
        >
          log out
        </button>
      </aside>
    </>
  );
};

export default SettingsDrawer;
