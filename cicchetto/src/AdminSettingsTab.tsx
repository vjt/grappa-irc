import { type Component, createSignal, onMount, Show } from "solid-js";
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
//   * `upload.image_per_file_cap_bytes` — per-file size limit for the
//     image category, enforced at the `POST /api/uploads` boundary
//     (413 file_too_large on overrun). The wire also carries
//     `video_per_file_cap_bytes` + `document_per_file_cap_bytes`;
//     Task 7 (uploads cluster) adds their inputs alongside — this
//     form edits the image cap only until then.
//   * `upload.global_cap_bytes` — global disk-budget ceiling; uploads
//     reject with 507 insufficient_storage when total live bytes +
//     incoming would exceed the cap.
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
  const [globalCapGB, setGlobalCapGB] = createSignal<number>(10);

  const applyView = (view: AdminSettingsView): void => {
    setSettings(view);
    setActiveHost(view.upload.active_host);
    setImageCapMB(view.upload.image_per_file_cap_bytes / MIB);
    setGlobalCapGB(view.upload.global_cap_bytes / GIB);
  };

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
        // Partial subtree — the controller upserts present keys only,
        // so the video/document caps stay untouched until Task 7 adds
        // their inputs.
        upload: {
          active_host: activeHost(),
          image_per_file_cap_bytes: Math.round(imageCapMB() * MIB),
          global_cap_bytes: Math.round(globalCapGB() * GIB),
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
      <header class="admin-settings-header">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading()}
          data-testid="admin-settings-refresh"
        >
          {loading() ? "loading…" : "refresh"}
        </button>
        <Show when={error()}>
          <span class="admin-settings-error" data-testid="admin-settings-error">
            error: {error()}
          </span>
        </Show>
      </header>

      <Show when={settings() !== null} fallback={<p>loading settings…</p>}>
        <form onSubmit={(e) => void onSave(e)} class="admin-settings-form" noValidate>
          <fieldset>
            <legend>Image upload</legend>

            <div class="admin-settings-field">
              <label for="admin-settings-active-host">Active host</label>
              <select
                id="admin-settings-active-host"
                data-testid="admin-settings-active-host"
                value={activeHost()}
                onChange={(e) => setActiveHost(e.currentTarget.value as "embedded" | "litterbox")}
                disabled={saving()}
                classList={{
                  "admin-settings-field-error": fieldError() === "upload.active_host",
                }}
              >
                <option value="embedded">embedded (this server)</option>
                <option value="litterbox">litterbox.catbox.moe</option>
              </select>
              <Show when={fieldError() === "upload.active_host"}>
                <span class="admin-settings-field-error-msg">invalid value</span>
              </Show>
            </div>

            <div class="admin-settings-field">
              <label for="admin-settings-per-file-cap">Image per-file cap (MB)</label>
              <input
                id="admin-settings-per-file-cap"
                data-testid="admin-settings-per-file-cap"
                type="number"
                min="1"
                step="1"
                value={imageCapMB()}
                onInput={(e) => setImageCapMB(Number(e.currentTarget.value))}
                disabled={saving()}
                classList={{
                  "admin-settings-field-error": fieldError() === "upload.image_per_file_cap_bytes",
                }}
              />
              <Show when={fieldError() === "upload.image_per_file_cap_bytes"}>
                <span class="admin-settings-field-error-msg">must be positive</span>
              </Show>
            </div>

            <div class="admin-settings-field">
              <label for="admin-settings-global-cap">Global cap (GB)</label>
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
              <Show when={fieldError() === "upload.global_cap_bytes"}>
                <span class="admin-settings-field-error-msg">must be positive</span>
              </Show>
            </div>
          </fieldset>

          <div class="admin-settings-actions">
            <button type="submit" disabled={saving()} data-testid="admin-settings-save">
              {saving() ? "saving…" : "save"}
            </button>
            <Show
              when={savedAt() !== null && !saving() && error() === null && fieldError() === null}
            >
              <span class="admin-settings-saved" data-testid="admin-settings-saved">
                saved
              </span>
            </Show>
          </div>
        </form>
      </Show>
    </div>
  );
};

export default AdminSettingsTab;
