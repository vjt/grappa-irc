import { createSignal } from "solid-js";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";
import type { UploadCategory } from "./uploadCategory";
import type { ServerSettingsWireUploadView } from "./wireTypes";

// UX-6-B2 (2026-05-21) — operator-visible server-settings reactive
// signal. Source of truth for the `embeddedHost.maxFileSizeBytes`
// per-category reactive lookup + the `activeHost()` host pick in
// `uploadHost.ts`.
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
// `maxFileSizeBytes(category)` reads from the host's own per-category
// fallback literals until the snapshot arrives.
//
// ## Identity-scoped — token rotation flushes the cache
//
// On logout / rotation the prior identity's settings must not leak
// into the new identity's first read. The `identityScopedStore`
// factory registers the reset; mirror of `awayStatus.ts`,
// `archive.ts`, etc.

export type ServerSettingsView = {
  // S15 — the internal (camelCase) host model derives its closed set
  // from the generated wire type, so a new server host propagates here
  // without a second hardcoded union.
  uploadActiveHost: ServerSettingsWireUploadView["active_host"];
  uploadPerFileCapBytes: Record<UploadCategory, number>;
  uploadGlobalCapBytes: number;
  // #324 — the deployment's HTTP host aliases (bare lowercased
  // hostnames the server advertised). `mediaLink.ts` admits an upload
  // link on ANY of them (they share the /uploads store). Always an
  // array — `[]` before the first snapshot / on an old server — so the
  // classifier falls back to the page origin only.
  httpHostAliases: string[];
};

// Public-subset wire shape — mirrors `GET /api/server-settings`
// response AND the `server_settings_changed` event's `upload` field.
// `upload` reuses the GENERATED `ServerSettingsWireUploadView`
// (wireTypes.ts, drift-gated against `Grappa.ServerSettings.Wire`) —
// the only delta vs the generated changed-payload is that the REST
// response carries no `kind` field. `http_host_aliases` (#324) is
// optional on the wire: an older server (mid-deploy) omits it, and the
// REST path is a blind cast — absent → `[]` (page origin only). The WS
// path narrows it strictly in userTopic.ts.
export type ServerSettingsWirePayload = {
  upload: ServerSettingsWireUploadView;
  http_host_aliases?: string[];
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [serverSettings, setServerSettings] = createSignal<ServerSettingsView | null>(null);

  onIdentityChange(() => setServerSettings(null));

  const applyServerSettings = (raw: ServerSettingsWirePayload): void => {
    setServerSettings({
      // The generated wire type widens `active_host` to `string`; the
      // WS path narrows strictly in userTopic.ts (unknown host → event
      // dropped), so an unknown value can only arrive via the REST
      // blind-cast. Treat it as the server default — same posture as
      // `activeHost()`'s anything-but-litterbox → embedded pick.
      uploadActiveHost: raw.upload.active_host === "litterbox" ? "litterbox" : "embedded",
      uploadPerFileCapBytes: {
        image: raw.upload.image_per_file_cap_bytes,
        video: raw.upload.video_per_file_cap_bytes,
        document: raw.upload.document_per_file_cap_bytes,
        audio: raw.upload.audio_per_file_cap_bytes,
      },
      uploadGlobalCapBytes: raw.upload.global_cap_bytes,
      // #324 — absent (old server / pre-snapshot / REST blind-cast) → []
      // so mediaLink admits the page origin only (pre-#324 behaviour).
      httpHostAliases: raw.http_host_aliases ?? [],
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
