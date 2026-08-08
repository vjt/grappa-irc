import {
  type Component,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import AliasSettings from "./AliasSettings";
import DeleteAccountModal from "./DeleteAccountModal";
import InlineConfirmButton from "./InlineConfirmButton";
import { windowCandidates } from "./lib/activeWindows";
import { ApiError, displayNick, type Network, visitorNetworkNick } from "./lib/api";
import { getSubject, token } from "./lib/auth";
import { getColoredNicklist } from "./lib/colorNicklist";
import { windowMuteKey } from "./lib/conversationMute";
import { syncedSetColoredNicklist, syncedSetTimeFormat } from "./lib/displayPrefs";
import { type FontSizeKey, getFontSize, setFontSize } from "./lib/fontSize";
import { errorMessage, friendlyApiError } from "./lib/friendlyApiError";
import { getHideNextActive, setHideNextActive } from "./lib/hideNextActive";
import { updateIdentity, updateNetworkPassword } from "./lib/lifecycle";
import { networks, user } from "./lib/networks";
import { mirrorNotificationPrefs } from "./lib/notificationPrefs";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
import {
  deletePushSubscription,
  deviceRows,
  disablePush,
  type EnablePushResult,
  enablePush,
  formatDeviceActivity,
  listPushDevices,
  type PushDeviceSummary,
  pushAvailable,
  renamePushDevice,
  type SubscriptionId,
  subscriptionIdForEndpoint,
} from "./lib/push";
import { reconnectConnectedNetworks } from "./lib/reconnect";
import { selectedChannel } from "./lib/selection";
import { consumePendingSettingsPage, type SettingsSubPage } from "./lib/settingsNav";
import { openShareModal } from "./lib/shareModal";
import { getTimeFormat, type TimeFormatKey } from "./lib/timeFormat";
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
import PerformSettings from "./PerformSettings";
import ThemeGallery from "./ThemeGallery";
import TotpSettings from "./TotpSettings";
import VhostSettingsPage from "./VhostSettingsPage";
import WatchlistsSettings from "./WatchlistsSettings";

// Right-overlay drawer. #460 — the main page is now an INDEX of nav rows;
// each row pushes into a dedicated sub-page. Some sub-pages are separate
// components (themes, watch lists, aliases, perform, vhost); three are INLINE
// `<Show>` blocks whose signals live in this component's body (general =
// upload retention + visitor identity; display = text size / timestamp /
// colored nicklist; push = notifications). The main page keeps, BELOW the
// index, the subject-gated affordances that aren't sub-pages: share session,
// delete account, done. (#986 retired three of them: admin console was an
// exact duplicate of the rail's admin action, and detach + quit moved into
// the rail actions menu behind a per-subject confirm modal.)
//
// open prop drives the .open class; the drawer stays mounted across
// open/close so onMount-loaded state (devices + prefs) doesn't refetch
// per open. Backdrop click fires onClose; Esc closes it via the
// keybindings drawer fallback (Shell.tsx closeDrawer) — the drawer is a
// scroll-lock-only overlay, NOT in the #232 modal ESC stack, so the
// delete-account modal opened FROM the drawer closes on the first Esc and
// the drawer itself on the next. (#392 — the share surface is a MODAL again,
// mounted in Shell and closed via the shared overlay Esc stack, NOT a drawer
// sub-page; the drawer's "share session" button just calls openShareModal.)

export type Props = {
  open: boolean;
  onClose: () => void;
};

const SettingsDrawer: Component<Props> = (props) => {
  const [size, setSize] = createSignal<FontSizeKey>(getFontSize());
  const [timeFmt, setTimeFmt] = createSignal<TimeFormatKey>(getTimeFormat());
  const [coloredNicklist, setColoredNicklistSig] = createSignal<boolean>(getColoredNicklist());

  const [prefs, setPrefs] = createSignal<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [devices, setDevices] = createSignal<PushDeviceSummary[]>([]);
  // #964 — the server row THIS browser registered, so its list entry can say
  // so. Proven by endpoint match (`subscriptionIdForEndpoint`), never guessed
  // from the UA: two same-browser rows are byte-identical, which is the whole
  // reason this issue exists. `null` = we cannot prove any row is ours (never
  // subscribed here / cleared site data) — then NO row gets the marker.
  const [currentDeviceId, setCurrentDeviceId] = createSignal<SubscriptionId | null>(null);
  // #964 — inline rename. `renamingId` is the row currently in edit mode
  // (at most one); the draft lives here rather than in the input so a
  // re-render from a background refreshDevices cannot discard the typing.
  const [renamingId, setRenamingId] = createSignal<SubscriptionId | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [renameError, setRenameError] = createSignal<string | null>(null);
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
  // #252 — settings sub-page navigation. The drawer is an index page ("main")
  // that can push into a dedicated sub-page; the pattern mirrors AdminPane's
  // tab signal. cic never originates vhost state — the sub-page reads
  // `vhostView` + reports changes up via the same save-on-change PUT flow.
  const [settingsPage, setSettingsPage] = createSignal<SettingsSubPage>("main");
  // Visitor-only gate for the share-session section. #392 — the share entry
  // opens a Shell-mounted MODAL (openShareModal), visitor-only (a user has no
  // portable session to share). #476 — the identity editor is NO LONGER gated
  // here: it moved to hasNetworks() (both subjects carry per-network identity
  // on their /networks rows), so isVisitor now guards ONLY share-session.
  const isVisitor = (): boolean => getSubject()?.kind === "visitor";
  // #363 — an incognito (ephemeral) visitor session must not be portable, so
  // share-session is hidden for it. Reads the persisted subject (same source
  // as isVisitor); narrow on kind first — `incognito` lives only on the
  // visitor variant.
  const isIncognito = (): boolean => {
    const s = getSubject();
    return s?.kind === "visitor" && s.incognito === true;
  };
  // #986 — the `showDetach()` gate + the two-tap `quitArmed` latch moved to
  // the rail with the buttons they served (`canDetach()` in lib/lifecycle
  // asks the same `isPersistentIdentity` question; the latch has no
  // successor — the shared confirm modal replaced the two-tap arm).
  // #157 — "delete account" is an IRREVERSIBLE total wipe, surfaced as a
  // SEPARATE affordance from quit (quit PRESERVES a persistent identity;
  // delete nukes it). It opens a confirm MODAL (type-your-name gate) — the
  // ONE typed gate in the product (#986: detach and quit explain and ask,
  // this one asks you to spell the identity out). Offered ONLY to a registered
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
  // The exact string the operator must type to arm deletion — account name
  // (user) or, for a visitor (no identity-wide nick), the SELECTED network
  // row's nick. #478 — the retired lowest-id "anchor" pick is gone: the
  // confirm nick follows the network the editor targets (focused-network
  // default), keeping the kind==="visitor" narrow via `visitorNetworkNick`.
  // Empty when /me or /networks hasn't loaded (the button is withheld then).
  const deleteConfirmationText = (): string => {
    const u = user();
    if (!u) return "";
    if (u.kind === "user") return displayNick(u);
    return visitorNetworkNick(selectedIdentityNetwork()) ?? "";
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
    setTimeFmt(value); // local signal for optimistic drawer UI
    syncedSetTimeFormat(value); // #449 — local apply + server PUT (converges devices)
  };

  const onColoredNicklistChange = (e: Event) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    setColoredNicklistSig(on); // local signal for optimistic drawer UI
    syncedSetColoredNicklist(on); // #449 — local apply + server PUT
  };

  // #914 — no drawer-local mirror signal (unlike the nicklist row above):
  // `getHideNextActive()` is already the module signal, so the checkbox binds
  // straight to it and there is no second copy to keep in sync.
  const onHideNextActiveChange = (e: Event) => {
    setHideNextActive((e.currentTarget as HTMLInputElement).checked);
  };

  // #986 — the `onDetach` / `onQuit` handlers moved to RailActions with
  // their buttons, and now fire through lib/lifecycle's `confirmDetach` /
  // `confirmQuit` so the modal states the per-subject consequence first.

  // #211 phase 6 — the #126 disconnect ⇄ reconnect handlers are RETIRED
  // (per-network park/reconnect moved to the home page; global disconnect
  // is `quit`). The `visitorConnected()` accessor (read the singular /me
  // `connected` scalar) went with them — the scalar is dropped from /me.

  // #476 / #478 — per-network identity editor (nick + ident + realname),
  // live-applied via PATCH /networks/:slug/identity → internal reconnect.
  // Available to BOTH subjects: the visitor-only gate was a retired-premise
  // relic ("users have no per-network identity"). A user carries per-network
  // identity on its GET /networks rows too (both subjects converged, ruling
  // A). The editor targets the SELECTED network row, defaulting to the
  // currently-focused network, with a picker to switch when the subject holds
  // more than one — killing the #211-phase-7 lowest-id "anchor" pick (#478).
  // The text shadows seed from the selected row on open; a save PATCHes then
  // refetches. A 422 (bad nick/ident) surfaces inline via `identityError`.
  const identityNetworks = (): Network[] => networks() ?? [];
  const hasNetworks = (): boolean => identityNetworks().length > 0;

  const [selectedIdentitySlug, setSelectedIdentitySlug] = createSignal<string | null>(null);
  // The network row the editor currently targets: the explicitly-selected
  // slug, else the first row (a stable fallback until the open-seed lands).
  const selectedIdentityNetwork = (): Network | null => {
    const list = identityNetworks();
    return list.find((n) => n.slug === selectedIdentitySlug()) ?? list[0] ?? null;
  };

  const [nickText, setNickText] = createSignal("");
  const [identText, setIdentText] = createSignal("");
  const [realnameText, setRealnameText] = createSignal("");
  const [identitySaving, setIdentitySaving] = createSignal(false);
  const [identityError, setIdentityError] = createSignal<string | null>(null);
  const [identitySaved, setIdentitySaved] = createSignal(false);
  // Two-tap arm for the apply button (parent owns the flag per
  // InlineConfirmButton's contract) — the reconnect is disruptive
  // (session bounces), so it arms rather than firing on the first tap. #986
  // retired the settings copies of this control for the LIFECYCLE verbs only
  // — as a per-row apply gate it is unchanged, here and at its ~20 other
  // call sites.
  const [identityArmed, setIdentityArmed] = createSignal(false);

  // #124 — the per-network PASSWORD field. Its own signals and its own save,
  // NOT folded into the identity form above: the password is write-only and
  // leave-blank-to-keep, while the identity fields round-trip and treat a
  // blank as "clear to default". One Save over both would make an untouched
  // password field indistinguishable from "clear my password".
  const [passwordText, setPasswordText] = createSignal("");
  const [passwordSaving, setPasswordSaving] = createSignal(false);
  const [passwordError, setPasswordError] = createSignal<string | null>(null);
  const [passwordSaved, setPasswordSaved] = createSignal(false);
  const [passwordArmed, setPasswordArmed] = createSignal(false);

  // Default the editor's target ONCE per open-session: the currently-focused
  // network (if it resolves to one of the subject's rows), else the first
  // row. `identitySeeded` latches so a later /networks refetch never re-picks
  // the target out from under an in-progress edit. Reset on close (see the
  // close effect).
  const [identitySeeded, setIdentitySeeded] = createSignal(false);
  createEffect(() => {
    if (!props.open || identitySeeded()) return;
    const list = identityNetworks();
    const focusedSlug = selectedChannel()?.networkSlug ?? null;
    const defaultNet = list.find((n) => n.slug === focusedSlug) ?? list[0];
    if (!defaultNet) return;
    setSelectedIdentitySlug(defaultNet.slug);
    setIdentitySeeded(true);
  });

  // (Re-)seed the text fields whenever the TARGET network changes — the
  // initial default above, or a manual pick from the selector. `on` tracks
  // ONLY the slug, so a /networks refetch of the same target doesn't re-fire
  // and clobber in-progress typing. Clears transient save state on switch.
  createEffect(
    on(selectedIdentitySlug, (slug) => {
      if (slug === null) return;
      const net = identityNetworks().find((n) => n.slug === slug);
      if (!net) return;
      setNickText(net.nick);
      setIdentText(net.ident ?? "");
      setRealnameText(net.realname ?? "");
      setIdentityArmed(false);
      setIdentitySaved(false);
      setIdentityError(null);
    }),
  );

  const onSaveIdentity = async () => {
    setIdentityArmed(false);
    setIdentityError(null);
    setIdentitySaved(false);
    const net = selectedIdentityNetwork();
    if (!net) return;
    setIdentitySaving(true);
    try {
      // Send all three fields; blank ident/realname clears back to the
      // server default (ident → nick, realname → the subject default). Empty
      // string is a legitimate "unset" intent here — the settings editor is
      // the canonical edit surface, so it owns the full value including
      // clear. Nick is required (the credential can't be nickless).
      await updateIdentity(net.slug, {
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

  const onSavePassword = async () => {
    setPasswordArmed(false);
    setPasswordError(null);
    setPasswordSaved(false);
    const net = selectedIdentityNetwork();
    if (!net) return;
    // Leave-blank-to-keep lives HERE: an empty input is "I did not touch
    // this", never "clear my password". The server 400s a blank precisely so
    // this can never be an accident.
    const pw = passwordText();
    if (pw === "") return;
    setPasswordSaving(true);
    try {
      await updateNetworkPassword(net.slug, pw);
      setPasswordText("");
      setPasswordSaved(true);
    } catch (err) {
      setPasswordError(
        err instanceof ApiError ? friendlyApiError(err) : "Couldn't save the password. Try again.",
      );
    } finally {
      setPasswordSaving(false);
    }
  };

  // The drawer stays mounted across open/close (CSS .open toggle, not a
  // <Show>), so transient armed state would survive a close → reopen.
  // #157: close the delete-account modal so a reopened drawer never strands
  // the irreversible confirm dialog open. (#986 — the quit two-tap latch this
  // effect also disarmed left with the button; the rail's confirm modal is a
  // store-driven singleton that owns its own lifetime.)
  createEffect(() => {
    if (!props.open) {
      setDeleteOpen(false);
      // #152 — disarm the identity apply + clear transient save state so a
      // reopened drawer never sits one tap from a reconnect or shows a
      // stale "applied"/error banner. Reset the seed latch + selected target
      // so the next open re-defaults to the (now-current) focused network and
      // re-seeds the fields from its /networks row.
      setIdentityArmed(false);
      setIdentitySaved(false);
      setIdentityError(null);
      setIdentitySeeded(false);
      setSelectedIdentitySlug(null);
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
      // #868 — feed the live notify path the same authoritative map the form
      // renders, so the beep obeys a pref the moment it is read, not on the
      // next user-topic rejoin.
      mirrorNotificationPrefs(loaded);
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
      // #356 — discard any deep-link request that was set while the drawer
      // was already open (a bump that couldn't re-open it, so its open
      // transition never consumed the pending page). Clearing it on close
      // stops a stranded request from hijacking the NEXT normal open.
      consumePendingSettingsPage();
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
      setCurrentDeviceId(sub === null ? null : subscriptionIdForEndpoint(sub.endpoint));
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
      // #868 — mirror the server's NORMALIZED echo (not `next`): the whitelists
      // come back folded, which is the form the predicate compares against.
      mirrorNotificationPrefs(saved);
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

  // #866 — the per-conversation mute list, sorted by the stored (folded) key
  // so the rows do not reshuffle when one is added.
  const mutedConversations = (): { key: string; until: number | null }[] =>
    Object.entries(prefs().muted_targets ?? {})
      .map(([key, target]) => ({ key, until: target.until }))
      .sort((a, b) => a.key.localeCompare(b.key));

  // What the picker offers: the conversations the SIDEBAR shows (joined and
  // parted channels, open queries), never a free-text field over all of IRC —
  // vjt's Q5. Deduped by the folded key because `muted_targets` is per-subject
  // and carries no network: `#grappa` on two networks is ONE mute, and
  // offering it twice would imply otherwise. Already-muted keys drop out, so
  // the picker cannot re-add a row that is on screen right below it.
  const muteCandidates = (): { key: string; label: string }[] => {
    const muted = prefs().muted_targets ?? {};
    const byKey = new Map<string, string>();
    for (const candidate of windowCandidates()) {
      const key = windowMuteKey(candidate);
      if (Object.hasOwn(muted, key) || byKey.has(key)) continue;
      byKey.set(key, candidate.channelName);
    }
    return [...byKey]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.key.localeCompare(b.key));
  };

  // `until: null` — permanent. The shape carries the snooze field from day
  // one (Q1) but this cut exposes no picker for it, so every mute the UI
  // creates is permanent until removed.
  const muteConversation = (key: string) => {
    if (key === "") return;
    const current = prefs();
    void savePrefs({
      ...current,
      muted_targets: { ...(current.muted_targets ?? {}), [key]: { until: null } },
    });
  };

  const unmuteConversation = (key: string) => {
    const current = prefs();
    const next = { ...(current.muted_targets ?? {}) };
    delete next[key];
    void savePrefs({ ...current, muted_targets: next });
  };

  const onMasterToggle = async (checked: boolean) => {
    const t = token();
    if (t === null) return;
    setPushBanner(null);
    if (checked) {
      const result: EnablePushResult = await enablePush(t);
      if (result.status === "enabled") {
        setPushEnabled(true);
        // #964 — the drawer does NOT remount after the toggle, so the mount-time
        // probe never re-runs; take the id straight off the enable result.
        setCurrentDeviceId(result.subscriptionId);
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
      setCurrentDeviceId(null);
      await refreshDevices();
    }
  };

  // #964 — opens the row's editor. Seeded with the STORED label, never with
  // the derived default: pre-filling "Firefox on Linux #2" and hitting save
  // would freeze today's ordinal into a stored label, which is the stale
  // number the derived design exists to avoid.
  const startRename = (device: PushDeviceSummary) => {
    setRenameError(null);
    setRenameDraft(device.label ?? "");
    setRenamingId(device.id);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameError(null);
  };

  // Unlike removeDevice, a failure here is NOT swallowed: a 422 past the
  // length cap is the user's own input coming back, and silently dropping
  // it would look like the rename simply did not take.
  const commitRename = async (id: SubscriptionId) => {
    const t = token();
    if (t === null) return;
    try {
      await renamePushDevice(t, id, renameDraft());
      setRenamingId(null);
      setRenameError(null);
      await refreshDevices();
    } catch (err) {
      setRenameError(errorMessage(err));
    }
  };

  const removeDevice = async (id: SubscriptionId) => {
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

  // #460 / #476 — the general sub-page is conditionally composed (upload
  // retention is host-gated, per-network identity is network-gated — shown to
  // BOTH subjects whenever a network row exists), so its index subtitle names
  // ONLY the children the current subject will actually see — honest, and
  // consistent with the row's own reactive OR-gate. At least one part is always
  // present (the row is gated on the OR of the two), so it is never empty.
  const generalSubtitle = (): string => {
    const parts: string[] = [];
    if (activeHost().ttlOptions.length > 0) parts.push("upload retention");
    if (hasNetworks()) parts.push("per-network identity");
    return parts.join(" and ");
  };

  // #460 — shared back-header for the INLINE sub-pages (general / display /
  // push), mirroring the AliasSettings / WatchlistsSettings convention so
  // every sub-page presents one consistent "‹ back" affordance. Local (not a
  // component) so it stays inside the signal scope without prop threading.
  const subpageHeader = (title: string, backTestId: string) => (
    <header class="settings-subpage-header">
      <button
        type="button"
        class="settings-back"
        data-testid={backTestId}
        aria-label="back to settings"
        onClick={() => setSettingsPage("main")}
      >
        ‹ back
      </button>
      <h3>{title}</h3>
    </header>
  );

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

        {/* #460 — the main settings page is an INDEX of nav rows. Each row
            pushes into a dedicated sub-page (a `<Show>`-gated block that
            replaces the index in place); the header × stays visible for both.
            Below the index sit the subject-gated affordances that are NOT
            sub-pages (share session, delete account, done — #986 moved the
            lifecycle verbs to the rail and dropped the duplicate admin
            entry). */}
        <Show when={settingsPage() === "main"}>
          {/* Index rows, in order: general, display, themes, push
              (notifications), watch lists, aliases, on-connect commands,
              source address (LAST). */}

          {/* general — upload retention (host-gated) + per-network identity
              (network-gated, both subjects — #476). The row is gated on the OR
              of its children so it never opens an empty page. */}
          <Show when={activeHost().ttlOptions.length > 0 || hasNetworks()}>
            <button
              type="button"
              class="settings-nav-row"
              data-testid="general-settings-entry"
              onClick={() => setSettingsPage("general")}
            >
              <span class="settings-nav-row-text">
                <span class="settings-nav-row-label">general</span>
                <span class="settings-nav-row-subtitle">{generalSubtitle()}</span>
              </span>
              <span class="settings-nav-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </Show>

          {/* display — text size, timestamp format, colored nicklist (#443). */}
          <Show when={getSubject()?.kind === "user"}>
            <button
              type="button"
              class="settings-nav-row"
              data-testid="security-settings-entry"
              onClick={() => setSettingsPage("security")}
            >
              <span class="settings-nav-row-text">
                <span class="settings-nav-row-label">security</span>
                <span class="settings-nav-row-subtitle">
                  password and two-factor authentication
                </span>
              </span>
              <span class="settings-nav-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </Show>

          {/* display — text size, timestamp format, colored nicklist (#443). */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="display-settings-entry"
            onClick={() => setSettingsPage("display")}
          >
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">display</span>
              <span class="settings-nav-row-subtitle">text size, timestamps, colored nicklist</span>
            </span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* #75 — themes gallery sub-page nav row. Always available (any
              logged-in subject can browse + apply the published + built-in
              gallery). */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="themes-settings-entry"
            onClick={() => setSettingsPage("themes")}
          >
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">themes</span>
              <span class="settings-nav-row-subtitle">browse and apply color themes</span>
            </span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* push — notifications: push permission + per-trigger prefs +
              device list. */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="push-settings-entry"
            onClick={() => setSettingsPage("push")}
          >
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">notifications</span>
              <span class="settings-nav-row-subtitle">push permission and per-trigger alerts</span>
            </span>
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
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">watch lists</span>
              <span class="settings-nav-row-subtitle">presence notify and keyword highlight</span>
            </span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* #385 — aliases sub-page nav row (user-defined command aliases).
              Also deep-linked by the bare /alias compose verb via
              requestOpenSettings("aliases"). */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="aliases-settings-entry"
            onClick={() => setSettingsPage("aliases")}
          >
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">aliases</span>
              <span class="settings-nav-row-subtitle">your own slash-command shortcuts</span>
            </span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* #189 — on-connect perform list nav row (per-network raw IRC
              commands run at 001, before autojoin). Sits right after aliases —
              both are command-automation surfaces. */}
          <button
            type="button"
            class="settings-nav-row"
            data-testid="perform-settings-entry"
            onClick={() => setSettingsPage("perform")}
          >
            <span class="settings-nav-row-text">
              <span class="settings-nav-row-label">on-connect commands</span>
              <span class="settings-nav-row-subtitle">raw IRC commands run on connect</span>
            </span>
            <span class="settings-nav-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>

          {/* #252 — source address (vhost) nav row. LAST in the index; the
              interim #228 `<select multiple>` is replaced by a dedicated,
              mobile-friendly SUB-PAGE (tap-select, NAME-primary). It renders
              only once the server view has loaded (non-null). */}
          <Show when={vhostView() !== null}>
            <button
              type="button"
              class="settings-nav-row"
              data-testid="vhost-settings-entry"
              onClick={enterVhostPage}
            >
              <span class="settings-nav-row-text">
                <span class="settings-nav-row-label">source address (vhost)</span>
                <span class="settings-nav-row-subtitle">the address you connect from</span>
              </span>
              <span class="settings-nav-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </Show>

          {/* #986 — the `admin console` entry is GONE. It was an exact
            duplicate of the rail's 🔧 admin action: same `isAdmin()` gate,
            same `setSelectedChannel({ kind: "admin" })` payload, same
            destination. Its `onOpenAdmin` prop and both Shell wirings went
            with it — a dead prop left behind is how the next reader concludes
            the two paths differed. */}

          {/* #392 — session-share entry. isVisitor()-gated (mint 403s for
              users — the modal is never reachable for a password subject).
              #363 — also hidden while incognito: an ephemeral session must not
              be portable to another device. #460 — split out of the old
              isVisitor block (identity moved into the general sub-page); the
              share entry STAYS on the main index. */}
          <Show when={isVisitor() && !isIncognito()}>
            <button
              type="button"
              class="settings-share-button"
              data-testid="share-session-entry"
              onClick={() => openShareModal()}
            >
              <span class="settings-share-button-label">share session</span>
              <span class="settings-share-button-subtitle muted">
                open this session on another device
              </span>
            </button>
          </Show>

          {/* #986 — the canonical session-lifecycle verbs (detach + quit) are
            NO LONGER here. They moved into the rail actions menu
            (RailActions.tsx), each behind the shared #195 confirm modal that
            states, per subject, what the verb actually destroys. Two doors to
            a destructive verb — one confirmed and one not — is worse than
            either alone, so the drawer copies went with the move rather than
            staying as an unconfirmed shortcut.

            `delete account` below STAYS: it is the one irreversible door, it
            keeps its own type-your-name gate, and its geometry is #987. */}

          {/* #157 — delete account: IRREVERSIBLE total wipe, DISTINCT from
            quit (which PRESERVES a persistent identity). It keeps the
            type-your-name modal — #986's ruling is that the typed gate is
            about IRREVERSIBILITY, not subject kind, so it stays here and
            ONLY here. Offered to a registered non-admin user or a registered
            visitor; admins + anon visitors never see it. */}
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

        <Show when={settingsPage() === "security"}>
          <TotpSettings onBack={() => setSettingsPage("main")} />
        </Show>

        {/* #460 — general sub-page: upload retention (host-gated) + visitor
            identity (visitor-gated). Both blocks moved VERBATIM from the old
            flat main page. */}
        <Show when={settingsPage() === "general"}>
          <section class="settings-subpage general-subpage" data-testid="general-subpage">
            {subpageHeader("general", "general-back")}

            {/* #476 / #478 — per-network identity editor, both subjects. It
              targets the SELECTED network row (focused-network default), with a
              picker when the subject holds more than one — the retired lowest-id
              anchor is gone. Saving PATCHes /networks/:slug/identity which
              live-applies via internal reconnect (the session bounces +
              rejoins). The confirm-armed save communicates the reconnect cost;
              a 422 renders inline. Gated on hasNetworks() — you can't edit
              identity for a network you don't hold. */}
            {/* #335 — identity sits inside a titled .settings-section card. */}
            <Show when={hasNetworks()}>
              <div
                class="settings-section settings-section-card"
                data-testid="settings-section-identity"
              >
                <h4 class="settings-section-heading">identity</h4>
                <div class="settings-identity" data-testid="settings-identity">
                  {/* #497 — the network this identity edits. Shown ONLY when
                      the subject holds more than one network: a one-option
                      picker is noise (a single network is the common visitor
                      case), so the whole Network row is hidden there — the
                      nick/realname/ident fields self-evidently target the sole
                      network. The `for` always associates with the rendered
                      <select> now (no dangling-label a11y branch). */}
                  <Show when={identityNetworks().length > 1}>
                    <label for="settings-identity-network">Network</label>
                    {/* Lock the target while an apply is in flight — the save
                        captured a specific network; switching mid-reconnect
                        would surface its result banner under the wrong row. */}
                    <select
                      id="settings-identity-network"
                      data-testid="settings-identity-network-select"
                      disabled={identitySaving()}
                      value={selectedIdentityNetwork()?.slug ?? ""}
                      onChange={(e) => setSelectedIdentitySlug(e.currentTarget.value)}
                    >
                      <For each={identityNetworks()}>
                        {(net) => <option value={net.slug}>{net.slug}</option>}
                      </For>
                    </select>
                  </Show>

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

              {/* #124 — the per-network password. THE one place this secret is
                editable: it is the credential password, the value
                `$nickserv_pass` expands to, and for a visitor the credential
                you log into grappa with. The perform editor's rival field is
                gone — two editable homes for one secret was the split brain
                this cures. Targets the same network the identity card above
                does, so the picker there governs both. */}
              <div
                class="settings-section settings-section-card"
                data-testid="settings-section-password"
              >
                <h4 class="settings-section-heading">password</h4>
                <div class="settings-identity" data-testid="settings-password">
                  <label for="settings-network-password">Network password</label>
                  <input
                    id="settings-network-password"
                    type="password"
                    autocapitalize="none"
                    autocorrect="off"
                    spellcheck={false}
                    placeholder="type a new password (leave blank to keep)"
                    value={passwordText()}
                    data-testid="settings-network-password-input"
                    onInput={(e) => {
                      setPasswordText(e.currentTarget.value);
                      setPasswordSaved(false);
                    }}
                  />
                  <p class="settings-identity-hint">
                    Your NickServ password for this network. Saving reconnects your session so it
                    can identify with the new value — you'll briefly drop and rejoin your channels.
                  </p>

                  <InlineConfirmButton
                    idleLabel={passwordSaving() ? "saving…" : "save password"}
                    confirmLabel="save — this reconnects"
                    testId="settings-password-apply"
                    armed={passwordArmed()}
                    onArm={() => setPasswordArmed(true)}
                    onConfirm={() => {
                      void onSavePassword();
                    }}
                  />

                  <Show when={passwordError()}>
                    {(msg) => (
                      <p
                        role="alert"
                        class="settings-identity-error"
                        data-testid="settings-password-error"
                      >
                        {msg()}
                      </p>
                    )}
                  </Show>
                  <Show when={passwordSaved()}>
                    <p class="settings-identity-ok" data-testid="settings-password-ok">
                      Password saved.
                    </p>
                  </Show>
                </div>
              </div>
            </Show>

            {/* #497 — upload retention moved BELOW identity: identity is what a
              user looks for; upload duration is a rarely-touched knob.
              UX-4 bucket M (2026-05-19) — host-gated: only renders when the
              active image host exposes ttlOptions (litterbox does; a
              hypothetical imgur-style host wouldn't). The `<option value="">`
              "use site default" entry maps to a `null` PUT — clears the
              preference and falls back to `activeHost().defaultTtl`. Server
              stores integer seconds, cic translates at this boundary. */}
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
          </section>
        </Show>

        {/* #460 — display sub-page: text size, timestamp format, and the
            colored-nicklist toggle (#443 section moved VERBATIM). */}
        <Show when={settingsPage() === "display"}>
          <section class="settings-subpage display-subpage" data-testid="display-subpage">
            {subpageHeader("display", "display-back")}

            {/* #299 — the legacy auto/mirc-light/irssi-dark radio selector was
                removed. It is superseded by the #75 theme gallery (a themes
                nav row on the index) and was broken: an active gallery theme
                layers inline CSS vars over the [data-theme] base blocks, so
                toggling the radio did nothing visible. The base look is
                OS-resolved at boot (lib/theme.applyTheme). */}
            <section class="settings-section" data-testid="settings-section-display">
              <h4 class="settings-section-heading">display options</h4>

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

              {/* #443 — per-nick colors in the members pane. Off by default: the
                nicklist stays monochrome so its color reads as the mode tier,
                not identity. When on, MembersPane drops `noColor` so NickText
                applies the per-nick hash hue; the mode-prefix glyph keeps its
                own tier color either way. */}
              <fieldset class="colored-nicklist-fieldset">
                <legend>nicklist</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={coloredNicklist()}
                    onChange={onColoredNicklistChange}
                    data-testid="colored-nicklist-toggle"
                  />
                  show colored nicklist
                </label>
              </fieldset>

              {/* #914 — hide the #235 "jump to next active window" (»N)
                button. Off by default. PRESENTATIONAL: it removes the button
                in BOTH placements (desktop sidebar + mobile overlay) and
                nothing else — Alt+A and Ctrl+N keep jumping. Client-local and
                per-DEVICE, unlike the two synced rows above; the complaint is
                the viewport-fixed mobile overlay. */}
              <fieldset class="hide-next-active-fieldset">
                <legend>jump button</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={getHideNextActive()}
                    onChange={onHideNextActiveChange}
                    data-testid="hide-next-active-toggle"
                  />
                  hide the jump-to-next-active button
                </label>
              </fieldset>
            </section>
          </section>
        </Show>

        {/* #460 — push sub-page: notifications (push permission + per-trigger
            prefs + device list). Moved VERBATIM from the old flat main page. */}
        <Show when={settingsPage() === "push"}>
          <section class="settings-subpage push-subpage" data-testid="push-subpage">
            {subpageHeader("notifications", "push-back")}

            <fieldset class="notifications-fieldset">
              <legend>notifications</legend>
              <label class="master-toggle">
                <input
                  type="checkbox"
                  checked={pushEnabled()}
                  // #459 — discover unavailability UP-FRONT (same
                  // `pushAvailable()` gate as the login opt-in banner) instead
                  // of only after the click surfaces enablePush's `unsupported`
                  // arm. A disabled toggle over a dead capability reads as
                  // honest; the hint below says why.
                  disabled={!pushAvailable()}
                  onChange={(e) => {
                    void onMasterToggle((e.currentTarget as HTMLInputElement).checked);
                  }}
                  data-testid="push-master-toggle"
                />
                enable browser notifications
              </label>
              <Show when={!pushAvailable()}>
                <p class="push-banner" role="status" data-testid="push-unavailable">
                  Push notifications aren't available in this browser. On iOS, install Cicchetto to
                  your home screen first.
                </p>
              </Show>
              <Show when={pushBanner() !== null}>
                <p class="push-banner" role="alert" data-testid="push-banner">
                  {pushBanner()}
                </p>
              </Show>

              <hr />

              {/* #866 — the section used to be one flat run of four controls
                  in which "only in channels" sat between two checkboxes about
                  different things and "channel mentions" trailed the whitelist
                  it does not belong to. Grouped under headings so each
                  question ("when do channels notify me?", "when do DMs?",
                  "what never does?") is answered in one place, and so the mute
                  list has a home rather than being bolted onto the end. */}
              <h3>channels</h3>
              <label>
                <input
                  type="checkbox"
                  checked={prefs().channel_messages_all}
                  disabled={savingPrefs()}
                  onChange={(e) =>
                    togglePref(
                      "channel_messages_all",
                      (e.currentTarget as HTMLInputElement).checked,
                    )
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

              <h3>private messages</h3>
              <label>
                <input
                  type="checkbox"
                  checked={prefs().private_messages_all}
                  disabled={savingPrefs()}
                  onChange={(e) =>
                    togglePref(
                      "private_messages_all",
                      (e.currentTarget as HTMLInputElement).checked,
                    )
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

              <h3>muted conversations</h3>
              <p class="prefs-hint">
                A muted conversation never notifies — not even when someone says your nick. The name
                applies on every network.
              </p>
              <label class="prefs-list">
                mute:
                <select
                  disabled={savingPrefs() || muteCandidates().length === 0}
                  // Value resets to "" so the same conversation can be muted,
                  // removed, and muted again without the select getting stuck
                  // on a stale selection.
                  value=""
                  onChange={(e) => {
                    const el = e.currentTarget as HTMLSelectElement;
                    const picked = el.value;
                    el.value = "";
                    muteConversation(picked);
                  }}
                  data-testid="pref-mute-picker"
                >
                  <option value="">pick a conversation…</option>
                  <For each={muteCandidates()}>
                    {(candidate) => <option value={candidate.key}>{candidate.label}</option>}
                  </For>
                </select>
              </label>
              <Show when={mutedConversations().length > 0}>
                <ul class="watchlists-list" data-testid="pref-muted-list">
                  <For each={mutedConversations()}>
                    {(muted) => (
                      <li class="watchlists-item" data-testid={`pref-muted-${muted.key}`}>
                        <span class="watchlists-keyword">{muted.key}</span>
                        <button
                          type="button"
                          class="watchlists-remove"
                          disabled={savingPrefs()}
                          aria-label={`Unmute ${muted.key}`}
                          onClick={() => unmuteConversation(muted.key)}
                        >
                          ×
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={prefsError() !== null}>
                <p class="prefs-error" role="alert" data-testid="prefs-error">
                  {prefsError()}
                </p>
              </Show>

              <Show when={devices().length > 0}>
                <h3>devices</h3>
                <ul class="devices-list" data-testid="devices-list">
                  <For each={deviceRows(devices())}>
                    {(row) => {
                      const d = row.device;
                      // UX-4 bucket L (2026-05-19) — replace the raw UA
                      // string with `{icon} {Browser} on {OS}`. Title
                      // attribute preserves the full UA so a hover (desktop)
                      // can still surface the original for debugging /
                      // device disambiguation across same-browser instances.
                      const parsed = parseUserAgent(d.user_agent);
                      // #964 — hover is the ONLY disambiguator today and it does
                      // not exist on touch, which is where the drawer lives. The
                      // activity instant + the this-device marker are the two
                      // always-visible ones. Stamped at render, not on a ticking
                      // clock: the list is refetched on drawer mount, so a live
                      // "3m ago → 4m ago" would out-freshen its own data.
                      const activity = formatDeviceActivity(d, Date.now());
                      const isCurrent = () => currentDeviceId() === d.id;
                      const editing = () => renamingId() === d.id;
                      return (
                        <li>
                          <Show
                            when={editing()}
                            fallback={
                              <>
                                <span class="device-ua" title={d.user_agent ?? "(unknown browser)"}>
                                  <span class="device-ua-icon" aria-hidden="true">
                                    {deviceClassIcon(parsed.deviceClass)}
                                  </span>
                                  <span class="device-ua-text">
                                    <span class="device-ua-title">
                                      <span class="device-ua-name" data-testid="device-name">
                                        {row.displayName}
                                      </span>
                                      <Show when={isCurrent()}>
                                        <span class="device-current" data-testid="device-current">
                                          ● this device
                                        </span>
                                      </Show>
                                    </span>
                                    {/* #964 — the parsed name survives as the
                                        secondary line ONLY once a label has
                                        taken its place above; printing it
                                        twice on an unnamed row says nothing. */}
                                    <Show when={row.named}>
                                      <span class="device-activity" data-testid="device-parsed">
                                        {parsed.browser} on {parsed.os}
                                      </span>
                                    </Show>
                                    <Show when={activity !== null}>
                                      <span class="device-activity" data-testid="device-activity">
                                        {activity}
                                      </span>
                                    </Show>
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  class="device-remove"
                                  data-testid="device-rename"
                                  onClick={() => startRename(d)}
                                >
                                  rename
                                </button>
                                <button
                                  type="button"
                                  class="device-remove"
                                  onClick={() => {
                                    void removeDevice(d.id);
                                  }}
                                >
                                  remove
                                </button>
                              </>
                            }
                          >
                            <span class="device-rename-form">
                              <input
                                type="text"
                                class="device-rename-input"
                                data-testid="device-name-input"
                                aria-label="device name"
                                // Empty draft = no label yet; the placeholder shows
                                // what the row falls back to, so clearing the field
                                // is a visible choice rather than a blank row.
                                placeholder={row.displayName}
                                value={renameDraft()}
                                onInput={(e) => setRenameDraft(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void commitRename(d.id);
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelRename();
                                  }
                                }}
                              />
                              <Show when={renameError() !== null}>
                                <span class="prefs-error" data-testid="device-rename-error">
                                  {renameError()}
                                </span>
                              </Show>
                            </span>
                            <button
                              type="button"
                              class="device-remove"
                              data-testid="device-rename-save"
                              onClick={() => {
                                void commitRename(d.id);
                              }}
                            >
                              save
                            </button>
                            <button
                              type="button"
                              class="device-remove"
                              data-testid="device-rename-cancel"
                              onClick={cancelRename}
                            >
                              cancel
                            </button>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </fieldset>
          </section>
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

        {/* #385 — aliases sub-page (user-defined command aliases).
            Self-contained: reads the aliasList store directly, so no data
            props. Reached via the nav row and bare /alias. */}
        <Show when={settingsPage() === "aliases"}>
          <AliasSettings onBack={() => setSettingsPage("main")} />
        </Show>

        {/* #189 — on-connect perform list sub-page (per-network). Self-
            contained: each block loads/saves its own list via the perform
            REST endpoints. Reached via the nav row. */}
        <Show when={settingsPage() === "perform"}>
          <PerformSettings onBack={() => setSettingsPage("main")} />
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
