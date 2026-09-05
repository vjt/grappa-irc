// User settings client — push-notifications cluster B3 (2026-05-14).
//
// Mirrors the wire shape of `GrappaWeb.UserSettingsJSON` and
// `Grappa.UserSettings.notification_prefs/0`. The server is the
// authoritative source — cic posts the full prefs map on every
// change (no PATCH/diff semantics) and re-reads on settings-drawer
// open. Read-from-cache is avoided so multi-device prefs converge
// after a single round-trip.
//
// Validation lives on the server (at-least-one-trigger + non-empty-
// string list members + lowercase normalization). cic submits the
// raw checkbox + textarea values; the 422 envelope (per
// FallbackController) carries `field_errors.notification_prefs`
// when the master toggle would silently mute the user — render
// inline.

import { ApiError, readError } from "./api";
import type { PresencePref } from "./presenceFilter";
import type { TimeFormatKey } from "./timeFormat";

// #866 — one muted conversation. `until` is a unix timestamp in SECONDS
// (the `upload_ttl_seconds` unit, not JS milliseconds); `null` means the
// mute is permanent. The field exists from day one even though this cut
// exposes no snooze picker, so a later "mute for 8 hours" needs no second
// structure beside this one — vjt's Q1 ruling.
export type MutedTarget = {
  until: number | null;
};

// Keyed by the FOLDED conversation: `canonicalChannel(channel)` for a
// channel, `canonicalChannel(peer)` for a DM. NOT by the row's `channel`
// field — an inbound DM carries `channel = own_nick`, so that key would
// make "mute me" mean "mute every DM I ever receive".
export type MutedTargets = Record<string, MutedTarget>;

export type NotificationPrefs = {
  channel_messages_all: boolean;
  channel_messages_only: string[];
  channel_mentions: boolean;
  private_messages_all: boolean;
  private_messages_only: string[];
  // #378 — the two `/notify` presence gates. They gate PUSH only: the in-app
  // presence toast fires regardless, on `initial: false` alone. Required (not
  // optional like `muted_targets`) because the server's `cast_bools` requires
  // every boolean present in a PUT — the full-PUT save path below has to
  // carry them or the save 422s.
  presence_online: boolean;
  presence_offline: boolean;
  // Optional because cic ships independently of the server (#618): a bundle
  // newer than the BEAM it talks to must tolerate the field being absent
  // rather than crash the predicate on every arriving message. Present in
  // DEFAULT_NOTIFICATION_PREFS, and every reader defaults it to `{}`.
  muted_targets?: MutedTargets;
};

export type NotificationPrefsResponse = {
  notification_prefs: NotificationPrefs;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channel_messages_all: false,
  channel_messages_only: [],
  channel_mentions: true,
  private_messages_all: true,
  private_messages_only: [],
  presence_online: false,
  presence_offline: false,
  muted_targets: {},
};

export async function getNotificationPrefs(token: string): Promise<NotificationPrefs> {
  const res = await fetch("/me/settings/notification-prefs", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "notification_prefs_get_failed");
  }
  const body = (await res.json()) as NotificationPrefsResponse;
  return body.notification_prefs;
}

export async function putNotificationPrefs(
  token: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const res = await fetch("/me/settings/notification-prefs", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(prefs),
  });
  // #112 — route through the ONE error decoder: dedups the redundant `error`
  // key from `info` AND fires the shared 401 dead-token handler this inline
  // shaper skipped (see `readError` moduledoc).
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as NotificationPrefsResponse;
  return body.notification_prefs;
}

// ---------------------------------------------------------------------------
// auto_away_debounce_seconds — #348.
//
// How long the bouncer waits, after the subject's last device goes
// hidden, before telling the network they are away. ONE scalar carries
// three states, because the delay and the off switch are one control:
//
//   null  no preference — the server's own default applies. cic does NOT
//         know that number and must not print one: it is a server
//         constant, and a copy here would drift the day it changes.
//   0     off. The bouncer arms no timer at all.
//   N     seconds.
//
// The accepted range lives on the server, deliberately un-mirrored here
// for the same reason: an out-of-range value comes back as a 422 whose
// message names the bounds, which is one source of truth instead of two.
// ---------------------------------------------------------------------------

export type AutoAwayDebounceResponse = {
  auto_away_debounce_seconds: number | null;
};

export async function getAutoAwayDebounceSeconds(token: string): Promise<number | null> {
  const res = await fetch("/me/settings/auto-away-debounce-seconds", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "auto_away_debounce_get_failed");
  }
  const body = (await res.json()) as AutoAwayDebounceResponse;
  return body.auto_away_debounce_seconds;
}

export async function putAutoAwayDebounceSeconds(
  token: string,
  seconds: number | null,
): Promise<number | null> {
  const res = await fetch("/me/settings/auto-away-debounce-seconds", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ auto_away_debounce_seconds: seconds }),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AutoAwayDebounceResponse;
  return body.auto_away_debounce_seconds;
}

// ---------------------------------------------------------------------------
// upload_ttl_seconds — UX-4 bucket M (2026-05-19).
//
// Server stores the operator's upload-TTL preference as an integer of
// seconds, in the `user_settings.data` JSON column under key
// `"upload_ttl_seconds"`. `null` is the "no preference set — fall back
// to the active host's `defaultTtl`" sentinel.
//
// Cic translates between the integer seconds and the host-specific
// token spelling (`"24h"` for litterbox's wire format) at the
// SettingsDrawer + uploadOrchestrator boundaries. The server stays
// oblivious to per-host ladders.
// ---------------------------------------------------------------------------

export type UploadTtlResponse = {
  upload_ttl_seconds: number | null;
};

export async function getUploadTtlSeconds(token: string): Promise<number | null> {
  const res = await fetch("/me/settings/upload-ttl-seconds", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "upload_ttl_get_failed");
  }
  const body = (await res.json()) as UploadTtlResponse;
  return body.upload_ttl_seconds;
}

export async function putUploadTtlSeconds(
  token: string,
  seconds: number | null,
): Promise<number | null> {
  const res = await fetch("/me/settings/upload-ttl-seconds", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ upload_ttl_seconds: seconds }),
  });
  // #112 — route through the ONE error decoder (see the notification-prefs
  // twin above): dedups `info.error` + fires the shared 401 handler.
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as UploadTtlResponse;
  return body.upload_ttl_seconds;
}

// ---------------------------------------------------------------------------
// vhost (source-bind) selection — #228.
//
// The server owns the set of vhosts a subject is allowed to bind to and
// the subject's current selection. `available` is the allow-set (each
// carries `in_pool` so the widget can group pool vs. non-pool, plus
// `granted` = an explicit per-subject grant row, for the V2 3-section
// bucketing — #251); `selection` is the subject's chosen addresses. There
// is no admin pin anymore (#251) — the user always self-selects.
//
// cic submits the raw selected addresses on every change (no diff
// semantics, mirroring the notification-prefs full-PUT convention). The
// 4xx envelope carries `error: "forbidden_vhost"` (a selected address
// isn't allowed) or `error: "bad_request"` (selection wasn't a list) —
// same body-parse-for-error-code dance as `putUploadTtlSeconds`.
// ---------------------------------------------------------------------------

export type VhostOption = {
  address: string;
  in_pool: boolean;
  granted: boolean;
  // #252 — the address's reverse-DNS (cloak) name, resolved server-side
  // (the DNS is the source of truth; nothing persisted). The vhost
  // sub-page renders this as the primary label with `address` as a muted
  // subline. Always a string: falls back to the raw `address` when the
  // address has no PTR record or the name isn't cached yet.
  name: string;
};

export type VhostSettingsView = {
  available: VhostOption[];
  selection: string[];
};

export async function getVhostSettings(token: string): Promise<VhostSettingsView> {
  const res = await fetch("/me/settings/vhost", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "vhost_get_failed");
  }
  return (await res.json()) as VhostSettingsView;
}

export async function putVhostSelection(
  token: string,
  selection: string[],
): Promise<VhostSettingsView> {
  const res = await fetch("/me/settings/vhost", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ selection }),
  });
  // #112 — route through the ONE error decoder (see the notification-prefs
  // twin above): dedups `info.error` + fires the shared 401 handler.
  if (!res.ok) throw await readError(res);
  return (await res.json()) as VhostSettingsView;
}

// ---------------------------------------------------------------------------
// aliases — user-defined command aliases (#385).
//
// A `%{name => expansion}` string map. Expansion grammar ($1..$9 / $N- / $* /
// implicit append), builtin-collision precedence, and recursion depth are
// all client-side (slashCommands.ts owns the DISPATCH table). The server
// validates only structural shape and returns the NORMALIZED map (names
// lowercased + trimmed), which the store mirrors as authoritative.
//
// Full-map PUT, no PATCH/diff — mirrors the notification-prefs convention.
// The body is wrapped under an `aliases` key so an empty map ("clear all")
// is distinguishable from a malformed request. The 422 envelope carries
// `field_errors.aliases`; the whole body is stashed on ApiError.info so
// friendlyApiError can render the per-field summary inline.
// ---------------------------------------------------------------------------

export type Aliases = Record<string, string>;

export type AliasesResponse = {
  aliases: Aliases;
};

export async function getAliases(token: string): Promise<Aliases> {
  const res = await fetch("/me/settings/aliases", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "aliases_get_failed");
  }
  const body = (await res.json()) as AliasesResponse;
  return body.aliases;
}

export async function putAliases(token: string, aliases: Aliases): Promise<Aliases> {
  const res = await fetch("/me/settings/aliases", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ aliases }),
  });
  // #112 — route through the ONE error decoder (see the notification-prefs
  // twin above): dedups `info.error` + fires the shared 401 handler.
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AliasesResponse;
  return body.aliases;
}

// ---------------------------------------------------------------------------
// display_prefs — server-backed display preferences (#449).
//
// The presence filter (#222), timestamp format (#217), and colored nicklist
// (#443) were localStorage-only, so they never converged across one account's
// devices (a desktop toggle stayed invisible on the iOS PWA — reported by
// Hypnotize). Move them onto a server-authoritative full-map path, but synced
// like the THEME (`customTheme.ts`): boot-cached apply for a FOUC-free first
// paint, then a login reconcile. The coordinator that owns the apply / seed-up
// logic is `displayPrefs.ts`; this module is only the fetch pair.
//
// `persisted` is the seed-up discriminator (mirrors the server's
// `display_prefs_persisted?/1`): `get_display_prefs/1` always returns a
// complete shape from defaults, so `false` (never written) vs `true` (server
// carries prefs) is the ONLY way the client can tell whether to push its local
// values up or let the server win. Additive per #447 — a pre-#449 server omits
// the field, so it is optional and the coordinator treats absent as `false`
// (seed-up), which is the safe direction (never wipes another device's config).
//
// Tri-state (NON-NEGOTIABLE): `presence_filter` values are `"show" | "hide"`;
// UNSET is the ABSENCE of a channel key, never a third value. The wire carries
// exactly the pinned channels; the coordinator's `resolvePresenceVisible`
// derives the size default for unset channels client-side.
// ---------------------------------------------------------------------------

export type DisplayPrefs = {
  time_format: TimeFormatKey;
  colored_nicklist: boolean;
  presence_filter: Record<string, PresencePref>;
  // #1766 — OPTIONAL on the READ side, always sent on the write side. A server
  // predating #1766 omits it, and this bundle can be deployed ahead of the
  // server (`deploy-m42.sh --cic` ships the bundle alone). Typed as required,
  // `applyServerPrefs` would hand `undefined` to the local setter and the bar
  // would vanish for every user until the server caught up — the mirror of the
  // skew the server tolerates on the PUT. Absent ⇒ the default, exactly like
  // `persisted?` below. `buildWireMap()` always populates it.
  show_bottom_bar?: boolean;
};

export type DisplayPrefsResponse = {
  display_prefs: DisplayPrefs;
  // Optional: a pre-#449 server omits it. Absent ⇒ treat as not-persisted.
  persisted?: boolean;
};

export async function getDisplayPrefs(token: string): Promise<DisplayPrefsResponse> {
  const res = await fetch("/me/settings/display-prefs", {
    headers: { authorization: `Bearer ${token}` },
  });
  // #449 — ISOLATED from the dead-token handler (`fireDeadTokenHandler: false`):
  // this is a boot-APPLIED cosmetic fetch (`mountDisplayPrefsSync` fires it on
  // every token presence), so a transient 401 must NOT log out a valid session.
  // It still throws so the coordinator keeps its FOUC-free boot cache.
  if (!res.ok) throw await readError(res, false);
  return (await res.json()) as DisplayPrefsResponse;
}

export async function putDisplayPrefs(
  token: string,
  prefs: DisplayPrefs,
): Promise<DisplayPrefsResponse> {
  const res = await fetch("/me/settings/display-prefs", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ display_prefs: prefs }),
  });
  // #112 — route through the ONE error decoder (dedups `info.error`, carries
  // `field_errors.display_prefs` on a 422 DOS-bound rejection). #449 — but
  // ISOLATED from the dead-token handler (`fireDeadTokenHandler: false`): the
  // synced PUT fires at boot (seed-up) and on every cosmetic toggle, so a
  // transient 401 must NOT clear a valid session's token. Fire-and-forget
  // callers already swallow the throw and keep the optimistic local state.
  if (!res.ok) throw await readError(res, false);
  return (await res.json()) as DisplayPrefsResponse;
}

// ---------------------------------------------------------------------------
// show_peer_profiles — M2. Opt-in to grappa querying OTHER users' CTCP
// USERINFO profile (the member-list gender badge's source). Default
// `false`. No live-broadcast bridge — a live session picks the change up
// on its next (re)spawn, so there's no cross-device sync signal to mirror
// here beyond a normal re-fetch on drawer open.
// ---------------------------------------------------------------------------

export type ShowPeerProfilesResponse = {
  show_peer_profiles: boolean;
};

export async function getShowPeerProfiles(token: string): Promise<boolean> {
  const res = await fetch("/me/settings/show-peer-profiles", {
    headers: { authorization: `Bearer ${token}` },
  });
  // #449, same reasoning as `getDisplayPrefs` above — ISOLATED from the
  // dead-token handler (`fireDeadTokenHandler: false`). This fires at
  // boot, not on a user action, and it is a COSMETIC read: a transient
  // 401 here must not clear a valid session's token and bounce the whole
  // Shell back to the login screen. `loadShowPeerProfiles` already
  // swallows the throw and leaves the cache at the server's own default.
  if (!res.ok) throw await readError(res, false);
  const body = (await res.json()) as ShowPeerProfilesResponse;
  return body.show_peer_profiles;
}

export async function putShowPeerProfiles(token: string, enabled: boolean): Promise<boolean> {
  const res = await fetch("/me/settings/show-peer-profiles", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ show_peer_profiles: enabled }),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as ShowPeerProfilesResponse;
  return body.show_peer_profiles;
}

// ---------------------------------------------------------------------------
// upload_confirm_enabled — #1883. Opt-IN to being asked before an upload
// leaves the device, for every door `uploadOrchestrator.triggerUploads`
// serves (picker, drop, pasted file, paste-as-.txt, OS share).
//
// Default `false`, so an operator who never opens settings is never asked.
// That default is the reversal #1883's own note argued against; the whole
// argument, and what changed, is on the server accessor
// (`Grappa.UserSettings.get_upload_confirm_enabled/1`) — the one place a
// reader of either side will find it.
//
// Read at UPLOAD time, not at boot: the confirm is a cic dialog and the
// server only stores the flag, so a flip takes effect on the next upload
// with no session involvement (unlike show_peer_profiles above, which the
// bouncer acts on and therefore waits for a respawn).
// ---------------------------------------------------------------------------

export type UploadConfirmEnabledResponse = {
  upload_confirm_enabled: boolean;
};

export async function getUploadConfirmEnabled(token: string): Promise<boolean> {
  const res = await fetch("/me/settings/upload-confirm-enabled", {
    headers: { authorization: `Bearer ${token}` },
  });
  // ISOLATED from the dead-token handler, exactly as `getShowPeerProfiles`
  // above: this is a cosmetic boot read, and a transient 401 must not clear
  // a valid session's token and bounce the Shell to the login screen.
  if (!res.ok) throw await readError(res, false);
  const body = (await res.json()) as UploadConfirmEnabledResponse;
  return body.upload_confirm_enabled;
}

export async function putUploadConfirmEnabled(token: string, enabled: boolean): Promise<boolean> {
  const res = await fetch("/me/settings/upload-confirm-enabled", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ upload_confirm_enabled: enabled }),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as UploadConfirmEnabledResponse;
  return body.upload_confirm_enabled;
}
