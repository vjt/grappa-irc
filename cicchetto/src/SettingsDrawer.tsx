import { useNavigate } from "@solidjs/router";
import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { getSubject, logout, token } from "./lib/auth";
import { type FontSizeKey, getFontSize, setFontSize } from "./lib/fontSize";
import {
  loadUploadTtlSeconds,
  saveUploadTtlSeconds,
  uploadTtlSecondsValue,
} from "./lib/imageUploadOrchestrator";
import { isAdmin } from "./lib/networks";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
import {
  deletePushSubscription,
  disablePush,
  type EnablePushResult,
  enablePush,
  listPushDevices,
  type PushDeviceSummary,
} from "./lib/push";
import { quitAll } from "./lib/quit";
import { getTheme, setTheme, type ThemePref } from "./lib/theme";
import { activeHost } from "./lib/uploadHost";
import { deviceClassIcon, parseUserAgent } from "./lib/userAgent";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  type NotificationPrefs,
  putNotificationPrefs,
} from "./lib/userSettings";
import ShareSessionModal from "./ShareSessionModal";

// Right-overlay drawer: theme toggle + notifications (push permission +
// per-trigger prefs + device list) + optional "admin console" entry
// (gated on `isAdmin()` from lib/networks.ts — single source of truth
// shared with Shell.tsx pane gate + Sidebar.tsx admin row) + logout.
//
// open prop drives the .open class; the drawer stays mounted across
// open/close so onMount-loaded state (devices + prefs) doesn't refetch
// per open. Backdrop click fires onClose; Esc handled in Shell.tsx.

export type Props = {
  open: boolean;
  onClose: () => void;
  // M-7 — fires when the operator clicks the "admin console" entry.
  // Shell.tsx handles closing the drawer + selecting the admin
  // window (UX-4 bucket N: selection-driven AdminPane mount;
  // pre-bucket-N Shell flipped a separate `adminOpen` signal).
  // Required even though only admin renderings invoke it — both
  // SettingsDrawer call sites in Shell (desktop + mobile) pass the
  // same selection-set handler.
  onOpenAdmin: () => void;
};

const SettingsDrawer: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [pref, setPref] = createSignal<ThemePref>(getTheme());
  const [size, setSize] = createSignal<FontSizeKey>(getFontSize());

  const [prefs, setPrefs] = createSignal<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [devices, setDevices] = createSignal<PushDeviceSummary[]>([]);
  const [pushEnabled, setPushEnabled] = createSignal(false);
  const [pushBanner, setPushBanner] = createSignal<string | null>(null);
  const [savingPrefs, setSavingPrefs] = createSignal(false);
  const [prefsError, setPrefsError] = createSignal<string | null>(null);
  // UX-4 bucket M (2026-05-19) — upload-TTL signals. Server is the
  // authoritative source; loadUploadTtlSeconds populates the cic
  // cache on drawer mount, saveUploadTtlSeconds round-trips on
  // change. `null` = "use the active host's defaultTtl".
  const [uploadTtlSavingError, setUploadTtlSavingError] = createSignal<string | null>(null);
  // Visitor session-sharing modal open state. Hidden for user
  // subjects entirely (users have passwords, no need to share).
  const [shareOpen, setShareOpen] = createSignal(false);
  const isVisitor = (): boolean => getSubject()?.kind === "visitor";
  // Issue #43 — the "detach" vs "quit IRC" split is only meaningful for
  // registered users (visitors have no persistent bouncer binding; the
  // not-yet-loaded null subject stays on the safe single button).
  const isUser = (): boolean => getSubject()?.kind === "user";
  // "quit IRC" is destructive (parks every network, bouncer offline), so
  // it arms via the shared two-tap InlineConfirmButton. Parent owns the
  // armed flag per that component's contract.
  const [quitArmed, setQuitArmed] = createSignal(false);
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

  const onFontSizeChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as FontSizeKey;
    setSize(value);
    setFontSize(value);
  };

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  // Issue #43 — "quit IRC": park ALL the user's networks then logout.
  // quitAll() already ships this composite (lib/quit.ts; also driven by
  // the /quit compose verb + the visitor sidebar ×). logout() inside it
  // nulls the token → RequireAuth redirects; the explicit navigate
  // mirrors onLogout so the post-quit landing is identical.
  const onQuit = async () => {
    await quitAll(null);
    navigate("/login", { replace: true });
  };

  // The drawer stays mounted across open/close (CSS .open toggle, not a
  // <Show>), so an armed quit button would survive a close → reopen and
  // sit one stray tap from killing the bouncer. Disarm on every close.
  createEffect(() => {
    if (!props.open) setQuitArmed(false);
  });

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
    const t = token();
    if (t !== null) {
      // UX-4 bucket M — populate the cic-side upload-TTL cache so the
      // fieldset's `<select>` reflects the server value before the
      // first user interaction.
      void loadUploadTtlSeconds(t);
    }
  });

  // UX-6 D12 (2026-05-21) — viewport diagnostics moved to AdminPane
  // Debug tab. The fieldset lived here through the UX-6-D 11-attempt
  // cluster; with the cluster closed and the diag now most useful
  // from a stable admin surface (closing settings to test the
  // keyboard hid the very diag you needed), the readouts + the
  // DiagFloat toggle live in `AdminDebugTab.tsx`. The floating
  // overlay itself (`DiagFloat.tsx`) is unchanged — mounted via
  // Portal in Shell, flag-gated via localStorage.cic_diag.

  // UX-6 bucket A — refcounted overlay scroll-lock. Push on open,
  // pop on close so `<html>` carries `.overlay-open` while any
  // overlay is up. v4: the scroll-lock targets the .settings-drawer
  // aside itself (its own `overflow-y: auto` is the legitimate scroll
  // surface body-scroll-lock-upgrade allows; touchmove on everything
  // else is preventDefaulted). Tracks the parent-owned `props.open`
  // accessor; the prior-value closure ensures one push per open
  // transition and one pop per close transition (no leaks if `open`
  // re-renders with the same value). onCleanup pops on unmount if
  // still open so a route-change mid-open doesn't leave the refcount
  // stuck.
  let drawerEl: HTMLElement | undefined;
  let wasOpen = false;
  createEffect(() => {
    const o = props.open;
    if (o && !wasOpen) {
      wasOpen = true;
      pushOverlay(drawerEl ?? null);
    } else if (!o && wasOpen) {
      wasOpen = false;
      popOverlay(drawerEl ?? null);
    }
  });
  onCleanup(() => {
    if (wasOpen) {
      wasOpen = false;
      popOverlay(drawerEl ?? null);
    }
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
    try {
      await deletePushSubscription(t, id);
      await refreshDevices();
    } catch {
      /* swallowed — UI will refresh on next drawer open */
    }
  };

  // UX-4 bucket M (2026-05-19) — upload-TTL `<select>` change handler.
  // Reads the host-token from the option `value=`, looks up its `seconds`
  // counterpart from `activeHost().ttlOptions`, and PUTs through.
  // Empty-string value = "use default" sentinel → PUTs `null` to clear
  // the server-side preference.
  const onUploadTtlChange = async (e: Event) => {
    const t = token();
    if (t === null) return;
    const select = e.currentTarget as HTMLSelectElement;
    const v = select.value;
    const next: number | null =
      v === "" ? null : (activeHost().ttlOptions.find((o) => o.value === v)?.seconds ?? null);
    setUploadTtlSavingError(null);
    try {
      await saveUploadTtlSeconds(t, next);
    } catch (err) {
      const code = err instanceof Error ? err.message : "save_failed";
      setUploadTtlSavingError(code);
    }
  };

  // Current `<select>` value: walk the active host's ladder to find an
  // entry whose `seconds` matches the cached preference. Empty string
  // when the preference is null (renders the "use site default" option).
  const uploadTtlSelectValue = (): string => {
    const seconds = uploadTtlSecondsValue();
    if (seconds === null) return "";
    return activeHost().ttlOptions.find((o) => o.seconds === seconds)?.value ?? "";
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
        ref={drawerEl}
        class="settings-drawer"
        classList={{ open: props.open }}
        role="dialog"
        aria-label="settings"
      >
        {/* UX-4 bucket L (2026-05-19) — sticky header with × close
            (desktop parity, top-right corner of the drawer). The
            bottom "done" button (added after `log out`) covers the
            mobile thumb-reach case where the × is awkward to tap at
            the top of a tall drawer. */}
        <header class="settings-drawer-header">
          <h2>settings</h2>
          <button
            type="button"
            class="settings-drawer-close"
            aria-label="close settings"
            data-testid="settings-drawer-close"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
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
                {(d) => {
                  // UX-4 bucket L (2026-05-19) — replace the raw UA
                  // string with `{icon} {Browser} on {OS}`. Title
                  // attribute preserves the full UA so a hover (desktop)
                  // can still surface the original for debugging /
                  // device disambiguation across same-browser instances.
                  const parsed = parseUserAgent(d.user_agent);
                  return (
                    <li>
                      <span class="device-ua" title={d.user_agent ?? "(unknown browser)"}>
                        <span class="device-ua-icon" aria-hidden="true">
                          {deviceClassIcon(parsed.deviceClass)}
                        </span>
                        <span class="device-ua-name">
                          {parsed.browser} on {parsed.os}
                        </span>
                      </span>
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
                  );
                }}
              </For>
            </ul>
          </Show>
        </fieldset>

        {/* UX-4 bucket M (2026-05-19) — image upload retention preference.
            Host-gated: only renders when the active image host exposes
            ttlOptions (litterbox does; a hypothetical imgur-style host
            wouldn't). The `<option value="">` "use site default" entry
            maps to a `null` PUT — clears the preference and falls back
            to `activeHost().defaultTtl`. Server stores integer seconds,
            cic translates to/from the host token at this boundary. */}
        <Show when={activeHost().ttlOptions.length > 0}>
          <fieldset class="upload-ttl-fieldset">
            <legend>image upload retention</legend>
            <label>
              upload duration:
              <select
                data-testid="upload-ttl-select"
                value={uploadTtlSelectValue()}
                onChange={(e) => {
                  void onUploadTtlChange(e);
                }}
              >
                <option value="">use site default ({activeHost().defaultTtl ?? ""})</option>
                <For each={activeHost().ttlOptions}>
                  {(opt) => <option value={opt.value}>{opt.label}</option>}
                </For>
              </select>
            </label>
            <Show when={uploadTtlSavingError() !== null}>
              <p class="upload-ttl-error" role="alert" data-testid="upload-ttl-error">
                {uploadTtlSavingError()}
              </p>
            </Show>
          </fieldset>
        </Show>

        <fieldset class="font-size-fieldset">
          <legend>text size</legend>
          <label>
            <input
              type="radio"
              name="font-size"
              value="S"
              checked={size() === "S"}
              onChange={onFontSizeChange}
              data-testid="font-size-S"
            />
            S
          </label>
          <label>
            <input
              type="radio"
              name="font-size"
              value="M"
              checked={size() === "M"}
              onChange={onFontSizeChange}
              data-testid="font-size-M"
            />
            M
          </label>
          <label>
            <input
              type="radio"
              name="font-size"
              value="L"
              checked={size() === "L"}
              onChange={onFontSizeChange}
              data-testid="font-size-L"
            />
            L
          </label>
          <label>
            <input
              type="radio"
              name="font-size"
              value="XL"
              checked={size() === "XL"}
              onChange={onFontSizeChange}
              data-testid="font-size-XL"
            />
            XL
          </label>
          <label>
            <input
              type="radio"
              name="font-size"
              value="XXL"
              checked={size() === "XXL"}
              onChange={onFontSizeChange}
              data-testid="font-size-XXL"
            />
            XXL
          </label>
        </fieldset>

        <Show when={isAdmin()}>
          <button
            type="button"
            class="admin-console-entry"
            onClick={() => {
              props.onClose();
              props.onOpenAdmin();
            }}
            data-testid="admin-console-entry"
          >
            admin console
          </button>
        </Show>

        <Show when={isVisitor()}>
          <button
            type="button"
            class="share-session-entry"
            data-testid="share-session-entry"
            onClick={() => setShareOpen(true)}
          >
            share session
          </button>
        </Show>

        {/* Issue #43 — registered users get two affordances: "detach"
            (today's logout — leave IRC connected) and a destructive
            two-tap "quit" (park ALL networks + logout, bouncer offline).
            Visitors + the not-yet-loaded null subject keep the single
            "log out" — the split is meaningless without a persistent
            bouncer binding. */}
        <Show
          when={isUser()}
          fallback={
            <button
              type="button"
              class="logout"
              onClick={() => {
                void onLogout();
              }}
            >
              log out
            </button>
          }
        >
          <button
            type="button"
            class="logout"
            data-testid="detach-btn"
            onClick={() => {
              void onLogout();
            }}
          >
            detach
          </button>
          <InlineConfirmButton
            idleLabel="quit"
            confirmLabel="really quit IRC?"
            armed={quitArmed()}
            onArm={() => setQuitArmed(true)}
            onConfirm={() => {
              void onQuit();
            }}
            testId="quit-irc-btn"
            extraClass="settings-quit"
          />
        </Show>

        {/* UX-6 D12 — viewport diagnostics fieldset moved to AdminPane
            Debug tab. See AdminDebugTab.tsx. */}

        {/* UX-4 bucket L — bottom "done" button. Same close verb as
            the top × — mobile thumb-reach surface. Sits below logout
            so the scroll position when scroll-to-bottom lands on a
            thumb-friendly close affordance. */}
        <button
          type="button"
          class="settings-drawer-done"
          data-testid="settings-drawer-done"
          onClick={props.onClose}
        >
          done
        </button>
      </aside>
      <ShareSessionModal open={shareOpen()} onClose={() => setShareOpen(false)} />
    </>
  );
};

export default SettingsDrawer;
