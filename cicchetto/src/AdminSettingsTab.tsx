import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminCard from "./admin/AdminCard";
import AdminField from "./admin/AdminField";
import { AdminLoading } from "./admin/AdminStatus";
import AdminToolbar from "./admin/AdminToolbar";
import { type AdminSettingsView, ApiError, adminGetSettings, adminPutSettings } from "./lib/api";
import { token } from "./lib/auth";

// UX-6-B2 (2026-05-21) — Admin Settings tab.
//
// Lets admin operators inspect + tune the global server-settings the
// operator-visible cic surface depends on:
//
//   * `upload.active_host` — `"embedded"` | `"litterbox"` pick. Drives
//     cic's `activeHost()` selector (the embedded grappa-served path
//     vs the catbox litterbox path).
//   * `upload.{image,video,document,audio}_per_file_cap_bytes` —
//     per-file size limits per upload category (uploads cluster Task 7,
//     2026-06-09; audio added GH #115), enforced at the
//     `POST /api/uploads` boundary (413 file_too_large on overrun).
//   * `upload.global_cap_bytes` — global disk-budget ceiling; uploads
//     reject with 507 insufficient_storage when total live bytes +
//     incoming would exceed the cap.
//   * `upload.video_max_duration_seconds` — video duration ceiling
//     (#201). Unlike the byte caps this one is enforced CLIENT-side:
//     duration is probed from the file in the browser, so an over-long
//     clip is refused before a single byte is POSTed.
//
// State model: same shape as `AdminVisitorsTab` (fetch on mount,
// explicit refresh, splice-on-save). UI units differ from wire:
// per-file cap shown in MB, global cap in GB, both stored as bytes
// on the wire. Conversion lives at the form-bind boundary.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. AdminPane's mount gate is the reachability
// boundary; non-admin + visitor can't get here.
//
// Validation surface: `Admin.SettingsController.update/2` returns
// 422 `{error: "invalid_setting", field: "upload.<key>"}` for any
// per-key validation failure. The form reads `err.info.field` to
// flag the offending input inline; an unmapped failure falls back
// to the wire token. NOT routed through `friendlyApiError` because
// the per-field highlight is more useful than a generic toast.
//
// Reactive fan-out: server fans out `server_settings_changed` on
// every live `Topic.user(name)` after a successful PUT (parity with
// `cic-bundle-changed`). Cic's `serverSettings()` signal hydrates
// from the broadcast; the admin tab also re-reads its local view
// from the PUT response (200 with full new view) to keep the form
// UI snappy without waiting for the WS round-trip.

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const AdminSettingsTab: Component = () => {
  const [settings, setSettings] = createSignal<AdminSettingsView | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [fieldError, setFieldError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);

  // Form-bound signals. Decoupled from `settings()` so the operator
  // can edit + cancel without round-tripping the server view.
  const [activeHost, setActiveHost] = createSignal<"embedded" | "litterbox">("embedded");
  const [imageCapMB, setImageCapMB] = createSignal<number>(10);
  const [videoCapMB, setVideoCapMB] = createSignal<number>(50);
  const [documentCapMB, setDocumentCapMB] = createSignal<number>(10);
  const [audioCapMB, setAudioCapMB] = createSignal<number>(25);
  const [globalCapGB, setGlobalCapGB] = createSignal<number>(10);
  // #201 — seconds on the wire AND in the form: a duration cap has no
  // unit conversion to hide, unlike the MB/GB byte fields above.
  const [videoMaxDurationS, setVideoMaxDurationS] = createSignal<number>(120);

  const applyView = (view: AdminSettingsView): void => {
    setSettings(view);
    setActiveHost(view.upload.active_host);
    setImageCapMB(view.upload.image_per_file_cap_bytes / MIB);
    setVideoCapMB(view.upload.video_per_file_cap_bytes / MIB);
    setDocumentCapMB(view.upload.document_per_file_cap_bytes / MIB);
    setAudioCapMB(view.upload.audio_per_file_cap_bytes / MIB);
    setGlobalCapGB(view.upload.global_cap_bytes / GIB);
    setVideoMaxDurationS(view.upload.video_max_duration_seconds);
  };

  // One row per per-type cap (uploads cluster Task 7) — same markup,
  // same MB↔bytes conversion, same field-error binding; only the
  // category differs. Static array, so a plain .map render is fine.
  const capFields = [
    {
      testid: "admin-settings-image-cap",
      label: "Image per-file cap (MB)",
      field: "upload.image_per_file_cap_bytes",
      value: imageCapMB,
      set: setImageCapMB,
    },
    {
      testid: "admin-settings-video-cap",
      label: "Video per-file cap (MB)",
      field: "upload.video_per_file_cap_bytes",
      value: videoCapMB,
      set: setVideoCapMB,
    },
    {
      testid: "admin-settings-document-cap",
      label: "Document per-file cap (MB)",
      field: "upload.document_per_file_cap_bytes",
      value: documentCapMB,
      set: setDocumentCapMB,
    },
    {
      testid: "admin-settings-audio-cap",
      label: "Audio per-file cap (MB)",
      field: "upload.audio_per_file_cap_bytes",
      value: audioCapMB,
      set: setAudioCapMB,
    },
  ] as const;

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setFieldError(null);
    try {
      const view = await adminGetSettings(t);
      applyView(view);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onSave = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      const view = await adminPutSettings(t, {
        upload: {
          active_host: activeHost(),
          image_per_file_cap_bytes: Math.round(imageCapMB() * MIB),
          video_per_file_cap_bytes: Math.round(videoCapMB() * MIB),
          document_per_file_cap_bytes: Math.round(documentCapMB() * MIB),
          audio_per_file_cap_bytes: Math.round(audioCapMB() * MIB),
          global_cap_bytes: Math.round(globalCapGB() * GIB),
          video_max_duration_seconds: Math.round(videoMaxDurationS()),
        },
      });
      applyView(view);
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_setting") {
        const field = err.info.field as string | undefined;
        setFieldError(field ?? "unknown");
      } else {
        const code = err instanceof ApiError ? err.code : "save_failed";
        setError(code);
      }
    } finally {
      setSaving(false);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-settings-tab" data-testid="admin-settings-tab">
      <AdminToolbar
        title="Settings"
        subtitle="Server-wide upload limits"
        actions={
          <button
            type="button"
            class="adm-btn adm-refresh-btn"
            onClick={() => void refresh()}
            disabled={loading()}
            data-testid="admin-settings-refresh"
          >
            {loading() ? "loading…" : "↻ refresh"}
          </button>
        }
      />

      <div class="adm-scroll">
        <Show when={error()}>
          <span class="adm-field-error" role="alert" data-testid="admin-settings-error">
            error: {error()}
          </span>
        </Show>

        <Show when={settings() !== null} fallback={<AdminLoading message="loading settings…" />}>
          <form onSubmit={(e) => void onSave(e)} class="admin-settings-form" noValidate>
            <AdminCard title="Uploads" subtitle="Applies to every network on this server">
              {/* Two columns per field — label left, control right —
                  instead of the stacked default. The fields are short
                  numbers with long names, so stacking wasted a full row
                  per field and left the card with no vertical rhythm at
                  all. See `.adm-field-rows` in default.css. */}
              <div class="adm-field-rows">
                <AdminField
                  label="Active host"
                  for="admin-settings-active-host"
                  error={fieldError() === "upload.active_host" ? "invalid value" : undefined}
                >
                  <select
                    id="admin-settings-active-host"
                    data-testid="admin-settings-active-host"
                    value={activeHost()}
                    onChange={(e) =>
                      setActiveHost(e.currentTarget.value as "embedded" | "litterbox")
                    }
                    disabled={saving()}
                    classList={{
                      "admin-settings-field-error": fieldError() === "upload.active_host",
                    }}
                  >
                    <option value="embedded">embedded (this server)</option>
                    <option value="litterbox">litterbox.catbox.moe</option>
                  </select>
                </AdminField>

                <For each={capFields}>
                  {(cap) => (
                    <AdminField
                      label={cap.label}
                      for={cap.testid}
                      error={fieldError() === cap.field ? "must be positive" : undefined}
                    >
                      <input
                        id={cap.testid}
                        data-testid={cap.testid}
                        type="number"
                        min="1"
                        step="1"
                        value={cap.value()}
                        onInput={(e) => cap.set(Number(e.currentTarget.value))}
                        disabled={saving()}
                        classList={{
                          "admin-settings-field-error": fieldError() === cap.field,
                        }}
                      />
                    </AdminField>
                  )}
                </For>

                <AdminField
                  label="Global cap (GB)"
                  for="admin-settings-global-cap"
                  error={
                    fieldError() === "upload.global_cap_bytes" ? "must be positive" : undefined
                  }
                >
                  <input
                    id="admin-settings-global-cap"
                    data-testid="admin-settings-global-cap"
                    type="number"
                    min="1"
                    step="1"
                    value={globalCapGB()}
                    onInput={(e) => setGlobalCapGB(Number(e.currentTarget.value))}
                    disabled={saving()}
                    classList={{
                      "admin-settings-field-error": fieldError() === "upload.global_cap_bytes",
                    }}
                  />
                </AdminField>

                <AdminField
                  label="Video max duration (s)"
                  for="admin-settings-video-max-duration"
                  error={
                    fieldError() === "upload.video_max_duration_seconds"
                      ? "must be positive"
                      : undefined
                  }
                >
                  <input
                    id="admin-settings-video-max-duration"
                    data-testid="admin-settings-video-max-duration"
                    type="number"
                    min="1"
                    step="1"
                    value={videoMaxDurationS()}
                    onInput={(e) => setVideoMaxDurationS(Number(e.currentTarget.value))}
                    disabled={saving()}
                    classList={{
                      "admin-settings-field-error":
                        fieldError() === "upload.video_max_duration_seconds",
                    }}
                  />
                </AdminField>
              </div>

              <div class="adm-toolbar-actions adm-card-footer">
                <button
                  type="submit"
                  class="adm-btn"
                  disabled={saving()}
                  data-testid="admin-settings-save"
                >
                  {saving() ? "saving…" : "save"}
                </button>
                <Show
                  when={
                    savedAt() !== null && !saving() && error() === null && fieldError() === null
                  }
                >
                  <span class="adm-field-hint" data-testid="admin-settings-saved">
                    saved
                  </span>
                </Show>
              </div>
            </AdminCard>
          </form>
        </Show>
      </div>
    </div>
  );
};

export default AdminSettingsTab;
