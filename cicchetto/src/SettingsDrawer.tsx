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
import DeleteAccountModal from "./DeleteAccountModal";
import InlineConfirmButton from "./InlineConfirmButton";
import { ApiError, displayNick, type Network, visitorAnchorNick } from "./lib/api";
import { getSubject, token } from "./lib/auth";
import { type FontSizeKey, getFontSize, setFontSize } from "./lib/fontSize";
import { friendlyApiError } from "./lib/friendlyApiError";
import { detach, quit, updateIdentity } from "./lib/lifecycle";
import { isAdmin, networks, user } from "./lib/networks";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
import {
  deletePushSubscription,
  disablePush,
  type EnablePushResult,
  enablePush,
  listPushDevices,
  type PushDeviceSummary,
} from "./lib/push";
import { reconnectConnectedNetworks } from "./lib/reconnect";
import { consumePendingSettingsPage, type SettingsSubPage } from "./lib/settingsNav";
import { getTimeFormat, setTimeFormat, type TimeFormatKey } from "./lib/timeFormat";
import { activeHost } from "./lib/uploadHost";
import {
  loadUploadTtlSeconds,
  saveUploadTtlSeconds,
  uploadTtlSecondsValue,
} from "./lib/uploadOrchestrator";
import { deviceClassIcon, parseUserAgent } from "./lib/userAgent";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  getVhostSettings,
  type NotificationPrefs,
  putNotificationPrefs,
  putVhostSelection,
  type VhostSettingsView,
} from "./lib/userSettings";
import ShareSessionPage from "./ShareSessionPage";
import ThemeGallery from "./ThemeGallery";
import VhostSettingsPage from "./VhostSettingsPage";
import WatchlistsSettings from "./WatchlistsSettings";

// Right-overlay drawer: theme toggle + notifications (push permission +
// per-trigger prefs + device list) + optional "admin console" entry
// (gated on `isAdmin()` from lib/networks.ts — single source of truth
// shared with Shell.tsx pane gate + Sidebar.tsx admin row) + logout.
//
// open prop drives the .open class; the drawer stays mounted across
// open/close so onMount-loaded state (devices + prefs) doesn't refetch
// per open. Backdrop click fires onClose; Esc closes it via the
// keybindings drawer fallback (Shell.tsx closeDrawer) — the drawer is a
// scroll-lock-only overlay, NOT in the #232 modal ESC stack, so the
// delete-account modal opened FROM the drawer closes on the first Esc and
// the drawer itself on the next. (#335 — share is no longer a modal; it's
// the "share" sub-page, closed by its own back button, not Esc.)

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
  const [size, setSize] = createSignal<FontSizeKey>(getFontSize());
  const [timeFmt, setTimeFmt] = createSignal<TimeFormatKey>(getTimeFormat());

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
  // #228, #251 — source-bind (vhost) selection. Server owns the allow-set +
  // current selection (no admin pin — #251). `null` view = not-yet-loaded
  // (the widget stays hidden until the first GET lands).
  const [vhostView, setVhostView] = createSignal<VhostSettingsView | null>(null);
  const [vhostError, setVhostError] = createSignal<string | null>(null);
  // #282 — explicit "Reconnect to apply" state for the vhost sub-page. The
  // vhost is inert until the upstream reconnects; the footer button bounces
  // the connected networks. `reconnecting` is the in-flight/double-fire
  // guard + drives the button label; `reconnectError` surfaces a failure.
  const [reconnecting, setReconnecting] = createSignal(false);
  const [reconnectError, setReconnectError] = createSignal<string | null>(null);
  // #252 — settings sub-page navigation. The drawer is a flat page ("main")
  // that can push into a dedicated sub-page ("vhost"); the pattern mirrors
  // AdminPane's tab signal and is reusable for future sub-pages. cic never
  // originates vhost state — the sub-page reads `vhostView` + reports
  // changes up via the same save-on-change PUT flow.
  const [settingsPage, setSettingsPage] = createSignal<SettingsSubPage>("main");
  // Visitor-only gate for the identity + share-session sections (#335 share
  // is now the "share" sub-page). Hidden for user subjects entirely — users
  // have passwords, no per-network identity editor, no session to share.
  const isVisitor = (): boolean => getSubject()?.kind === "visitor";
  const isUser = (): boolean => getSubject()?.kind === "user";
  // #126 — a registered (NickServ-identified) visitor is a PERSISTENT
  // identity (`registered === true`, derived server-side from
  // password_encrypted). It gets the persistent-identity verbs (detach +
  // disconnect/reconnect), like a user; an ephemeral visitor gets only
  // quit. The not-yet-loaded null subject falls through to quit-only too.
  const isRegisteredVisitor = (): boolean => {
    const s = getSubject();
    return s?.kind === "visitor" && s.registered === true;
  };
  // detach is offered to every persistent identity (user + NickServ
  // visitor); ephemeral visitors + the loading null-subject get only quit.
  const showDetach = (): boolean => isUser() || isRegisteredVisitor();
  // "quit IRC" is destructive (parks every network, bouncer offline), so
  // it arms via the shared two-tap InlineConfirmButton. Parent owns the
  // armed flag per that component's contract.
  const [quitArmed, setQuitArmed] = createSignal(false);
  // #157 — "delete account" is an IRREVERSIBLE total wipe, surfaced as a
  // SEPARATE affordance from quit (quit PRESERVES a persistent identity;
  // delete nukes it). It opens a confirm MODAL (type-your-name gate) —
  // stronger than quit's two-tap arm. Offered ONLY to a registered
  // NON-admin user or a registered visitor; admins (issue #157) + anon
  // visitors are excluded. Reads the reactive `/me` resource (authoritative
  // for is_admin / registered) so a mid-session demote/refetch flips it.
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const showDeleteAccount = (): boolean => {
    const u = user();
    if (!u) return false;
    if (u.kind === "user") return u.is_admin === false;
    return u.registered === true;
  };
  // The exact string the operator must type to arm deletion — account
  // name (user) or the visitor's anchor-network nick (visitor). #211
  // phase 7 — a visitor has no identity-wide nick, so use the anchor
  // (lowest-id) network row's nick. Empty when /me or /networks hasn't
  // loaded (the button is withheld in that state anyway).
  const deleteConfirmationText = (): string => {
    const u = user();
    if (!u) return "";
    if (u.kind === "user") return displayNick(u);
    return visitorAnchorNick(networks() ?? []) ?? "";
  };
  // Comma-separated UI shadows for the two whitelist text inputs — the
  // server stores normalized lists; cic edits are joined with ", " and
  // re-split on PUT so partial typing doesn't drop characters.
  const [channelsOnlyText, setChannelsOnlyText] = createSignal("");
  const [nicksOnlyText, setNicksOnlyText] = createSignal("");

  const onFontSizeChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as FontSizeKey;
    setSize(value);
    setFontSize(value);
  };

  const onTimeFormatChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as TimeFormatKey;
    setTimeFmt(value);
    setTimeFormat(value);
  };

  // #126 — detach: leave cic, KEEP the bouncer up. Persistent identities
  // only (gated by `showDetach()`). `detach()` revokes the web session;
  // the explicit navigate mirrors onQuit's post-logout landing.
  const onDetach = async () => {
    await detach();
    navigate("/login", { replace: true });
  };

  // #126 — quit: close cic AND tear down the live session. Universal;
  // `quit()` (lib/lifecycle.ts) routes per subject — user parks all
  // networks (the former quitAll, also driven by the /quit compose verb +
  // the sidebar ×), registered visitor drops the upstream then detaches
  // (row kept), ephemeral visitor detaches (server purges the anon row).
  // logout() inside nulls the token → RequireAuth redirects; the explicit
  // navigate makes the landing deterministic.
  const onQuit = async () => {
    await quit();
    navigate("/login", { replace: true });
  };

  // #211 phase 6 — the #126 disconnect ⇄ reconnect handlers are RETIRED
  // (per-network park/reconnect moved to the home page; global disconnect
  // is `quit`). The `visitorConnected()` accessor (read the singular /me
  // `connected` scalar) went with them — the scalar is dropped from /me.

  // #211 phase 7 — per-network identity editor (nick + ident + realname),
  // live-applied via PATCH /networks/:slug/identity → internal reconnect.
  // A visitor is multi-network with no identity-wide nick, so the editor
  // targets the visitor's ANCHOR network (lowest-id row) — the minimal
  // viable per-network editor. The text shadows seed from that network's
  // GET /networks row on drawer open; a save PATCHes then refetches /me +
  // /networks. A 422 (bad nick/ident) surfaces inline via `identityError`.
  const visitorAnchor = (): Network | null => {
    const list = networks() ?? [];
    return list
      .filter((n) => n.kind === "visitor")
      .reduce<Network | null>((lo, n) => (lo == null || n.id < lo.id ? n : lo), null);
  };

  const [nickText, setNickText] = createSignal("");
  const [identText, setIdentText] = createSignal("");
  const [realnameText, setRealnameText] = createSignal("");
  const [identitySaving, setIdentitySaving] = createSignal(false);
  const [identityError, setIdentityError] = createSignal<string | null>(null);
  const [identitySaved, setIdentitySaved] = createSignal(false);
  // Two-tap arm for the apply button (parent owns the flag per
  // InlineConfirmButton's contract) — the reconnect is disruptive
  // (session bounces), so it gets the same confirm gate as quit.
  const [identityArmed, setIdentityArmed] = createSignal(false);

  // Seed the identity fields from the visitor's ANCHOR network row ONCE per
  // open-session — on the open transition, or (if /networks hadn't loaded
  // yet at open) the first time the anchor resolves while open.
  // `identitySeeded` latches after the first seed so a later refetch never
  // clobbers the visitor's in-progress typing. Reset on close (see the
  // close effect).
  const [identitySeeded, setIdentitySeeded] = createSignal(false);
  createEffect(() => {
    if (!props.open || identitySeeded()) return;
    if (getSubject()?.kind !== "visitor") return;
    const anchor = visitorAnchor();
    if (anchor) {
      setNickText(anchor.nick);
      setIdentText(anchor.ident ?? "");
      setRealnameText(anchor.realname ?? "");
      setIdentitySeeded(true);
    }
  });

  const onSaveIdentity = async () => {
    setIdentityArmed(false);
    setIdentityError(null);
    setIdentitySaved(false);
    const anchor = visitorAnchor();
    if (!anchor) return;
    setIdentitySaving(true);
    try {
      // Send all three fields; blank ident/realname clears back to the
      // server default (ident → nick, realname → "Grappa Visitor"). Empty
      // string is a legitimate "unset" intent here — the settings editor is
      // the canonical edit surface, so it owns the full value including
      // clear. Nick is required (the credential can't be nickless).
      await updateIdentity(anchor.slug, {
        nick: nickText(),
        ident: identText(),
        realname: realnameText(),
      });
      setIdentitySaved(true);
    } catch (err) {
      setIdentityError(
        err instanceof ApiError ? friendlyApiError(err) : "Couldn't apply identity. Try again.",
      );
    } finally {
      setIdentitySaving(false);
    }
  };

  // The drawer stays mounted across open/close (CSS .open toggle, not a
  // <Show>), so an armed quit button would survive a close → reopen and
  // sit one stray tap from killing the bouncer. Disarm on every close.
  // #157: also close the delete-account modal so a reopened drawer never
  // strands the irreversible confirm dialog open.
  createEffect(() => {
    if (!props.open) {
      setQuitArmed(false);
      setDeleteOpen(false);
      // #152 — disarm the identity apply + clear transient save state so a
      // reopened drawer never sits one tap from a reconnect or shows a
      // stale "applied"/error banner. Reset the seed latch so the next
      // open re-seeds the fields from the (now-current) /me values.
      setIdentityArmed(false);
      setIdentitySaved(false);
      setIdentityError(null);
      setIdentitySeeded(false);
      // #282 — clear a stale reconnect error so a reopened drawer that
      // re-enters the vhost sub-page never strands the previous failure.
      setReconnectError(null);
    }
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
      // #228, #251 — load the source-bind (vhost) view so the widget
      // reflects the server's allow-set + current selection.
      void loadVhostSettings(t);
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
      // #75/#332 — the footer 🎨 launcher requests a deep-link into the
      // themes sub-page before opening; consume it (one-shot). No pending
      // request → stay on "main" (reset on the prior close below).
      const pending = consumePendingSettingsPage();
      if (pending !== null) setSettingsPage(pending);
    } else if (!o && wasOpen) {
      wasOpen = false;
      popOverlay(drawerEl ?? null);
      // #252 — a reopened drawer always lands on the main page.
      setSettingsPage("main");
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

  // #206 — human-readable label for the "use site default" option. The
  // default TTL is stored as a raw seconds token ("86400"); resolve it
  // through the SAME ttlOptions ladder the other options render from
  // ("24 hours") instead of leaking the integer. Falls back to the raw
  // token only if the default isn't in the ladder (host misconfig).
  const defaultTtlLabel = (): string => {
    const host = activeHost();
    const d = host.defaultTtl;
    if (d == null) return "";
    return host.ttlOptions.find((o) => o.value === d)?.label ?? d;
  };

  // #228 — load the vhost view. Swallow errors into the error signal (the
  // widget renders only when the view is non-null, so a failed load simply
  // keeps the section hidden — same informational-load posture as
  // refreshDevices, but surfaced inline for diagnostics).
  const loadVhostSettings = async (t: string): Promise<void> => {
    try {
      const view = await getVhostSettings(t);
      setVhostView(view);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "load_failed";
      setVhostError(code);
    }
  };

  // #252 — save-on-change handler for the vhost sub-page. Same PUT flow as
  // the retired #228 `<select multiple>` (clear error → PUT the full
  // selection → update the view → surface a `forbidden_vhost` /
  // `bad_request` code inline); the sub-page reports the new selection up.
  const saveVhostSelection = async (addresses: string[]): Promise<void> => {
    const t = token();
    if (t === null) return;
    setVhostError(null);
    try {
      const view = await putVhostSelection(t, addresses);
      setVhostView(view);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "save_failed";
      setVhostError(code);
    }
  };

  // #282 — explicit "Reconnect to apply". Bounces every connected network
  // via `reconnectConnectedNetworks` (park→reconnect per network — the clean
  // same-account path the home-page Reconnect uses, NOT the #281
  // account-switch client purge) so the new source address binds on the
  // fresh upstream. The `reconnecting` guard blocks double-fire; a failure
  // surfaces inline via friendlyApiError (errors MUST be visible —
  // feedback_silent_retry_anti_pattern).
  const reconnectSession = async (): Promise<void> => {
    if (reconnecting()) return;
    setReconnectError(null);
    setReconnecting(true);
    try {
      await reconnectConnectedNetworks();
    } catch (err) {
      setReconnectError(
        err instanceof ApiError ? friendlyApiError(err) : "reconnect failed (unknown error)",
      );
    } finally {
      setReconnecting(false);
    }
  };

  // #252 — navigate into the vhost sub-page. Re-reads the view on entry so
  // the resolved rDNS names land (the server resolves cold addresses out
  // of band after the drawer-open GET, per the non-blocking cache — a
  // second read on sub-page entry shows the names instead of raw IPs).
  const enterVhostPage = (): void => {
    const t = token();
    if (t !== null) void loadVhostSettings(t);
    // #282 review — clear a stale reconnect error so a back→re-enter within an
    // open drawer never strands a prior failure (close-effect clears it too,
    // but the within-drawer re-entry path is the gap the drawer close misses).
    setReconnectError(null);
    setSettingsPage("vhost");
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

        {/* #252 — main settings page. A `<Show>`-gated sub-page (vhost)
            renders in its place; the header × stays visible for both. */}
        <Show when={settingsPage() === "main"}>
          {/* #299 — the legacy auto/mirc-light/irssi-dark radio selector was
              removed here. It is superseded by the #75 theme gallery (cog →
              themes) and was broken: an active gallery theme layers inline
              CSS vars over the [data-theme] base blocks, so toggling the radio
              did nothing visible. The base look is now OS-resolved at boot
              (lib/theme.applyTheme). */}
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

          {/* UX-4 bucket M (2026-05-19) — upload retention preference.
            Host-gated: only renders when the active image host exposes
            ttlOptions (litterbox does; a hypothetical imgur-style host
            wouldn't). The `<option value="">` "use site default" entry
            maps to a `null` PUT — clears the preference and falls back
            to `activeHost().defaultTtl`. Server stores integer seconds,
            cic translates to/from the host token at this boundary. */}
          <Show when={activeHost().ttlOptions.length > 0}>
            <fieldset class="upload-ttl-fieldset">
              <legend>upload retention</legend>
              <label>
                upload duration:
                <select
                  data-testid="upload-ttl-select"
                  value={uploadTtlSelectValue()}
                  onChange={(e) => {
                    void onUploadTtlChange(e);
                  }}
                >
                  <option value="">use site default ({defaultTtlLabel()})</option>
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

          {/* #252 — source address (vhost). The interim #228 `<select
            multiple>` is replaced by a dedicated, mobile-friendly SUB-PAGE
            (tap-select, NAME-primary). This is the nav ROW into it; it
            renders only once the server view has loaded (non-null). */}
          <Show when={vhostView() !== null}>
            <button
              type="button"
              class="settings-nav-row"
              data-testid="vhost-settings-entry"
              onClick={enterVhostPage}
            >
              <span class="settings-nav-row-label">source address (vhost)</span>
              <span class="settings-nav-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </Show>

          {/* #75 — themes gallery sub-page nav row. Always available (any
              logged-in subject can browse + apply the published +
              built-in gallery). */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="themes-settings-entry"
            onClick={() => setSettingsPage("themes")}
          >
            <span class="settings-nav-row-label">themes</span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* #356 — watch lists sub-page nav row (presence notify + keyword
              highlight, one section). Also deep-linked by the bare
              /notify /watch /hilight /highlight compose verbs via
              requestOpenSettings("watchlists"). */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="watchlists-settings-entry"
            onClick={() => setSettingsPage("watchlists")}
          >
            <span class="settings-nav-row-label">watch lists</span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

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

          {/* #217 — message timestamp format. Closed-set (with/without
            seconds), client-only, persisted in localStorage. Mirrors the
            text-size radio-group pattern. */}
          <fieldset class="time-format-fieldset">
            <legend>timestamp format</legend>
            <label>
              <input
                type="radio"
                name="time-format"
                value="hms"
                checked={timeFmt() === "hms"}
                onChange={onTimeFormatChange}
                data-testid="time-format-hms"
              />
              with seconds (HH:MM:SS)
            </label>
            <label>
              <input
                type="radio"
                name="time-format"
                value="hm"
                checked={timeFmt() === "hm"}
                onChange={onTimeFormatChange}
                data-testid="time-format-hm"
              />
              no seconds (HH:MM)
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
            {/* #211 phase 7 — per-network visitor identity editor (targets
              the anchor network). Saving PATCHes /networks/:slug/identity
              which live-applies via internal reconnect (the session bounces
              + rejoins). The confirm-armed save communicates the reconnect
              cost; a 422 renders inline. */}
            {/* #335 — identity now sits inside a titled .settings-section
                card (was a bare, unstyled block with no wrapper). */}
            <div
              class="settings-section settings-section-card"
              data-testid="settings-section-identity"
            >
              <h4 class="settings-section-heading">identity</h4>
              <div class="settings-identity" data-testid="settings-identity">
                <label for="settings-nick">Nick</label>
                <input
                  id="settings-nick"
                  type="text"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  value={nickText()}
                  onInput={(e) => setNickText(e.currentTarget.value)}
                />

                <label for="settings-realname">Real name</label>
                <input
                  id="settings-realname"
                  type="text"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  value={realnameText()}
                  onInput={(e) => setRealnameText(e.currentTarget.value)}
                />

                <label for="settings-ident">Ident</label>
                <input
                  id="settings-ident"
                  type="text"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  value={identText()}
                  onInput={(e) => setIdentText(e.currentTarget.value)}
                />
                <p class="settings-identity-hint">
                  Applying reconnects your session — you'll briefly drop and rejoin your channels.
                </p>

                <InlineConfirmButton
                  idleLabel={identitySaving() ? "applying…" : "apply identity"}
                  confirmLabel="apply — this reconnects"
                  testId="settings-identity-apply"
                  armed={identityArmed()}
                  onArm={() => setIdentityArmed(true)}
                  onConfirm={() => {
                    void onSaveIdentity();
                  }}
                />

                <Show when={identityError()}>
                  {(msg) => (
                    <p
                      role="alert"
                      class="settings-identity-error"
                      data-testid="settings-identity-error"
                    >
                      {msg()}
                    </p>
                  )}
                </Show>
                <Show when={identitySaved()}>
                  <p class="settings-identity-ok" data-testid="settings-identity-ok">
                    Identity applied.
                  </p>
                </Show>
              </div>
            </div>

            {/* #335 — share-session section: a titled card (blurb + a
                section-button) whose button follows the vhost/themes nav-row
                pattern — tapping it pushes into the share sub-page, which
                mints a fresh link on mount. isVisitor()-gated (mint 403s for
                users). */}
            <div
              class="settings-section settings-section-card"
              data-testid="settings-section-share"
            >
              <h4 class="settings-section-heading">share session</h4>
              <p class="settings-section-blurb">open this session on another device.</p>
              <button
                type="button"
                class="settings-nav-row"
                data-testid="share-session-entry"
                onClick={() => setSettingsPage("share")}
              >
                <span class="settings-nav-row-label">create share link</span>
                <span class="settings-nav-row-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </div>
          </Show>

          {/* #126 — canonical session-lifecycle verbs ("log out" retired).
            detach (leave cic, KEEP the bouncer) + disconnect ⇄ reconnect
            (drop / restore the upstream, STAY in cic) are
            persistent-identity-only (user + NickServ visitor); quit
            (close cic AND tear down) is universal. An ephemeral visitor +
            the not-yet-loaded null subject get quit alone. */}
          <Show when={showDetach()}>
            <button
              type="button"
              class="logout"
              data-testid="detach-btn"
              onClick={() => {
                void onDetach();
              }}
            >
              detach
            </button>
          </Show>

          {/* #211 phase 6 — the visitor disconnect ⇄ reconnect toggle is
            RETIRED. Per-network park/reconnect now lives on the HOME PAGE
            for both subjects (ruling D); global disconnect is `quit`
            (park-all). */}

          {/* quit — universal destructive teardown, two-tap armed. */}
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

          {/* #157 — delete account: IRREVERSIBLE total wipe, DISTINCT from
            quit. Separate label + separate confirm (a type-your-name modal,
            stronger than quit's two-tap). Offered ONLY to a registered
            non-admin user or a registered visitor; admins + anon visitors
            never see it. */}
          <Show when={showDeleteAccount()}>
            <button
              type="button"
              class="delete-account-entry"
              data-testid="delete-account-btn"
              onClick={() => setDeleteOpen(true)}
            >
              delete account
            </button>
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
        </Show>

        {/* #252 — vhost sub-page. Replaces the main page while active; the
            server owns the allow-set + selection (cic mirrors). */}
        <Show when={settingsPage() === "vhost"}>
          <VhostSettingsPage
            view={vhostView()}
            error={vhostError()}
            onSetSelection={(addresses) => {
              void saveVhostSelection(addresses);
            }}
            onBack={() => setSettingsPage("main")}
            onReconnect={() => {
              void reconnectSession();
            }}
            reconnecting={reconnecting()}
            reconnectError={reconnectError()}
          />
        </Show>

        {/* #75 — themes gallery sub-page. Replaces the main page while
            active; the gallery owns its own server data loading. */}
        <Show when={settingsPage() === "themes"}>
          <ThemeGallery onBack={() => setSettingsPage("main")} />
        </Show>

        {/* #356 — watch lists sub-page (presence notify + keyword highlight).
            Self-contained: reads the notifyWatch + highlightList stores
            directly (like the retired home WatchedPanel), so no data props. */}
        <Show when={settingsPage() === "watchlists"}>
          <WatchlistsSettings onBack={() => setSettingsPage("main")} />
        </Show>

        {/* #335 — share-session sub-page (was ShareSessionModal). Entered
            from the visitor "share session" section-button; mints a fresh
            share link on mount + offers copy / native-share. Back returns
            to main, unmounting it (discards the on-screen token). */}
        <Show when={settingsPage() === "share"}>
          <ShareSessionPage onBack={() => setSettingsPage("main")} />
        </Show>
      </aside>
      <DeleteAccountModal
        open={deleteOpen()}
        onClose={() => setDeleteOpen(false)}
        confirmationText={deleteConfirmationText()}
      />
    </>
  );
};

export default SettingsDrawer;
