import { createSignal } from "solid-js";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";

// UX-6-B2 (2026-05-21) — operator-visible server-settings reactive
// signal. Source of truth for the `embeddedHost.maxFileSizeBytes`
// reactive lookup + the `activeHost()` host pick in `image-upload.ts`.
//
// ## Wire shape
//
// Mirrors `Grappa.ServerSettings.Wire.server_settings_changed/1`
// (atoms-out — `upload.active_host` is the string the server's
// `Atom.to_string/1` produces). The same shape ships from THREE doors:
//
//   * WS after-join snapshot — `GrappaChannel.push_server_settings/1`
//     pushes the current view on every user-topic join. This is the
//     PRIMARY initial-hydration path: cic always opens the user-topic
//     WS at boot via `userTopic.ts`'s `createRoot`, so the snapshot
//     populates `serverSettings()` before the first ComposeBox render.
//   * WS update broadcast — `Admin.SettingsController.update/2` fans
//     out the `server_settings_changed` push on every live
//     `Topic.user(name)` (parity with the cic-bundle-changed fan-out).
//     Same wire shape, same setter — auto-applies in any open tab.
//   * REST initial fetch — `loadServerSettings()` calls
//     `GET /api/server-settings`. Used by `AdminSettingsTab` for
//     explicit refresh + by tests; production cold-start gets the WS
//     snapshot first and the REST fetch is redundant.
//
// Cic's `userTopic.ts` dispatches on `kind: "server_settings_changed"`
// and routes the payload through `applyServerSettings/1`.
//
// ## Why a signal (not a per-call REST fetch)
//
// `embeddedHost.maxFileSizeBytes` is read by ComposeBox's drag-drop /
// paste gate every time the operator drops an image; an REST round
// trip would block the picker. The signal is hydrated by the WS
// snapshot at boot + auto-updates from the WS push, so reads are
// local + reactive. ComposeBox + SettingsDrawer + PrivacyModal all
// subscribe via `serverSettings()` getter.
//
// ## Defaults before initial WS snapshot
//
// Pre-snapshot state: `null`. `activeHost()` falls back to the
// embedded host in that case (the server-side default + the post-
// deploy default — operators reading the bundle before the snapshot
// returns get the same answer the server will give them).
// `maxFileSizeBytes` reads from the host's own `maxFileSizeBytes`
// literal until the snapshot arrives.
//
// ## Identity-scoped — token rotation flushes the cache
//
// On logout / rotation the prior identity's settings must not leak
// into the new identity's first read. The `identityScopedStore`
// factory registers the reset; mirror of `awayStatus.ts`,
// `archive.ts`, etc.

export type ServerSettingsView = {
  uploadActiveHost: "embedded" | "litterbox";
  uploadPerFileCapBytes: number;
  uploadGlobalCapBytes: number;
};

// Public-subset wire shape — mirrors `GET /api/server-settings`
// response AND the `server_settings_changed` event's `upload` field.
export type ServerSettingsWirePayload = {
  upload: {
    active_host: "embedded" | "litterbox";
    per_file_cap_bytes: number;
    global_cap_bytes: number;
  };
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [serverSettings, setServerSettings] = createSignal<ServerSettingsView | null>(null);

  onIdentityChange(() => setServerSettings(null));

  const applyServerSettings = (raw: ServerSettingsWirePayload): void => {
    setServerSettings({
      uploadActiveHost: raw.upload.active_host,
      uploadPerFileCapBytes: raw.upload.per_file_cap_bytes,
      uploadGlobalCapBytes: raw.upload.global_cap_bytes,
    });
  };

  // Initial fetch — called once at Shell mount post-login. WS push
  // takes over from there. Failures leave the signal `null`
  // (`activeHost()` falls back to embedded; cap reads fall back to
  // the host literal). Same swallow-on-transient-failure pattern as
  // `archive.ts:loadArchive`.
  const loadServerSettings = async (): Promise<void> => {
    const t = token();
    if (!t) return;
    try {
      const res = await fetch("/api/server-settings", {
        headers: { authorization: `Bearer ${t}` },
      });
      if (!res.ok) return;
      const raw = (await res.json()) as ServerSettingsWirePayload;
      applyServerSettings(raw);
    } catch {
      // Network blip — keep prior signal value (or null) and let the
      // next WS broadcast settle the state.
    }
  };

  return { serverSettings, setServerSettings, applyServerSettings, loadServerSettings };
});

export const serverSettings = exports_.serverSettings;
export const setServerSettings = exports_.setServerSettings;
export const applyServerSettings = exports_.applyServerSettings;
export const loadServerSettings = exports_.loadServerSettings;
