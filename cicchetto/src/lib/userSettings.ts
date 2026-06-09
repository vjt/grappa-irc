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

import { ApiError } from "./api";

export type NotificationPrefs = {
  channel_messages_all: boolean;
  channel_messages_only: string[];
  channel_mentions: boolean;
  private_messages_all: boolean;
  private_messages_only: string[];
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
  if (!res.ok) {
    let info: Record<string, unknown> = {};
    let code = res.statusText || "notification_prefs_put_failed";
    try {
      info = (await res.json()) as Record<string, unknown>;
      if (typeof info.error === "string") code = info.error;
    } catch {
      /* fallthrough — code stays as statusText */
    }
    throw new ApiError(res.status, code, info);
  }
  const body = (await res.json()) as NotificationPrefsResponse;
  return body.notification_prefs;
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
  if (!res.ok) {
    let info: Record<string, unknown> = {};
    let code = res.statusText || "upload_ttl_put_failed";
    try {
      info = (await res.json()) as Record<string, unknown>;
      if (typeof info.error === "string") code = info.error;
    } catch {
      /* fallthrough — code stays as statusText */
    }
    throw new ApiError(res.status, code, info);
  }
  const body = (await res.json()) as UploadTtlResponse;
  return body.upload_ttl_seconds;
}
