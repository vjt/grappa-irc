import {
  type Accessor,
  type Component,
  createSignal,
  For,
  type JSX,
  onMount,
  type Setter,
  Show,
} from "solid-js";
import AdminCard from "./admin/AdminCard";
import AdminField from "./admin/AdminField";
import { AdminLoading } from "./admin/AdminStatus";
import AdminToolbar from "./admin/AdminToolbar";
import { useRefreshSlot } from "./admin/refreshSlot";
import { type AdminSettingsView, ApiError, adminGetSettings, adminPutSettings } from "./lib/api";
import { token } from "./lib/auth";
import { AUTO_AWAY_PRESETS, formatAutoAwaySeconds } from "./lib/autoAwayLadder";

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
//   * `dcc.max_transfer_bytes` / `dcc.global_cap_bytes` — the two DCC
//     ceilings (issue 2185, form in issue 2202): the per-transfer size
//     limit and the whole spool's disk budget.
//   * `auto_away.default_debounce_seconds` — the auto-away SITE default
//     (issue 2359): the window a session waits when its user chose none.
//     A ladder, not a number field: the server accepts only the user
//     presets plus off. The empty entry is `null` — no stored value, the
//     server's boot config applies — and it names that config's value.
//
// ⚠️ The two DCC keys are NOT cross-validated against each other, on
// vjt's ruling (`settings_controller.ex` @dcc_keys / `ServerSettings`):
// a per-transfer ceiling above the spool budget is a legal end state.
// This form therefore does NOT check one against the other — a
// client-side rule the server does not enforce is a lie in the UI.
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
// 422 `{error: "invalid_setting", field: "<subtree>.<key>"}` for any
// per-key validation failure. The form reads `err.info.field` to
// flag the offending input inline; an unmapped failure falls back
// to the wire token. NOT routed through `friendlyApiError` because
// the per-field highlight is more useful than a generic toast.
// The highlight keys on the DOTTED path, never the bare key:
// `global_cap_bytes` names a different budget under `upload` than
// under `dcc`, and matching on the key alone would light both rows.
//
// Reactive fan-out: server fans out `server_settings_changed` on
// every live `Topic.user(name)` after a successful PUT (parity with
// `cic-bundle-changed`). Cic's `serverSettings()` signal hydrates
// from the broadcast; the admin tab also re-reads its local view
// from the PUT response (200 with full new view) to keep the form
// UI snappy without waiting for the WS round-trip.

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// One numeric setting: identical markup, identical field-error binding,
// identical "must be positive" copy — only the label, the signal pair and
// the dotted wire key differ. The unit conversion is NOT here: a row
// renders whatever number its signal holds, and `applyView`/`onSave` own
// the MiB/GiB↔bytes translation at the one boundary that crosses it.
type NumberRow = {
  testid: string;
  label: string;
  field: string;
  value: Accessor<number>;
  set: Setter<number>;
};

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
  // issue 2202 — the DCC pair. Seeded from the `dcc` subtree of the admin
  // view, which is admin-only (not in `public_view/0`).
  const [dccMaxTransferMiB, setDccMaxTransferMiB] = createSignal<number>(100);
  const [dccGlobalCapGiB, setDccGlobalCapGiB] = createSignal<number>(10);
  // issue 2359 — the select's value: "" = null (follow the server config),
  // otherwise the seconds as a string, "0" being off.
  const [autoAwayDefault, setAutoAwayDefault] = createSignal<string>("");

  // The `null` entry names the value it stands for — the server's boot
  // config — so "follow config" is never a blind pick.
  const serverConfigLabel = (): string => {
    const view = settings();
    return view === null
      ? "server config"
      : `server config (${formatAutoAwaySeconds(view.auto_away.fallback_debounce_seconds)})`;
  };

  const applyView = (view: AdminSettingsView): void => {
    setSettings(view);
    setActiveHost(view.upload.active_host);
    setImageCapMB(view.upload.image_per_file_cap_bytes / MIB);
    setVideoCapMB(view.upload.video_per_file_cap_bytes / MIB);
    setDocumentCapMB(view.upload.document_per_file_cap_bytes / MIB);
    setAudioCapMB(view.upload.audio_per_file_cap_bytes / MIB);
    setGlobalCapGB(view.upload.global_cap_bytes / GIB);
    setVideoMaxDurationS(view.upload.video_max_duration_seconds);
    setDccMaxTransferMiB(view.dcc.max_transfer_bytes / MIB);
    setDccGlobalCapGiB(view.dcc.global_cap_bytes / GIB);
    const stored = view.auto_away.default_debounce_seconds;
    setAutoAwayDefault(stored === null ? "" : String(stored));
  };

  // Every numeric row of the upload card, in render order. The four
  // per-type caps (uploads cluster Task 7) were already a list; the global
  // cap and the #201 duration ceiling were hand-written copies of the same
  // markup, which is what would have made a second family of caps (issue
  // 2202) the third and fourth copy. One list, one renderer.
  const uploadRows: NumberRow[] = [
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
    {
      testid: "admin-settings-global-cap",
      label: "Global cap (GB)",
      field: "upload.global_cap_bytes",
      value: globalCapGB,
      set: setGlobalCapGB,
    },
    {
      testid: "admin-settings-video-max-duration",
      label: "Video max duration (s)",
      field: "upload.video_max_duration_seconds",
      value: videoMaxDurationS,
      set: setVideoMaxDurationS,
    },
  ];

  // issue 2202 — the DCC card's rows. Labelled MiB/GiB because that is
  // what the ×1024² / ×1024³ round-trip below actually is; the upload
  // labels above say MB/GB over the same arithmetic, which is a
  // pre-existing inaccuracy this slice does not widen and does not copy.
  const dccRows: NumberRow[] = [
    {
      testid: "admin-settings-dcc-max-transfer",
      label: "Per-transfer cap (MiB)",
      field: "dcc.max_transfer_bytes",
      value: dccMaxTransferMiB,
      set: setDccMaxTransferMiB,
    },
    {
      testid: "admin-settings-dcc-global-cap",
      label: "Spool budget (GiB)",
      field: "dcc.global_cap_bytes",
      value: dccGlobalCapGiB,
      set: setDccGlobalCapGiB,
    },
  ];

  const numberRow = (row: NumberRow): JSX.Element => (
    <AdminField
      label={row.label}
      for={row.testid}
      error={fieldError() === row.field ? "must be positive" : undefined}
    >
      <input
        id={row.testid}
        data-testid={row.testid}
        type="number"
        min="1"
        step="1"
        value={row.value()}
        onInput={(e) => row.set(Number(e.currentTarget.value))}
        disabled={saving()}
        classList={{ "admin-settings-field-error": fieldError() === row.field }}
      />
    </AdminField>
  );

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
        dcc: {
          max_transfer_bytes: Math.round(dccMaxTransferMiB() * MIB),
          global_cap_bytes: Math.round(dccGlobalCapGiB() * GIB),
        },
        auto_away: {
          default_debounce_seconds: autoAwayDefault() === "" ? null : Number(autoAwayDefault()),
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

  // #1411 — Settings acquired its refresh AFTER the shared extraction and got
  // a hand-rolled copy of the button rather than the slot the other fetching
  // tabs use. The copy carried no `aria-label`, so its accessible name was the
  // literal text and swapped to "loading…" mid-fetch — a screen reader
  // announces that as the control being renamed, not as a busy state — and it
  // never reached the rail's ☰ actions, so the operator's mobile refresh path
  // failed on this one tab alone. Registration is the fix for both: the shared
  // button names itself once and sets `aria-busy`, and the slot is what the
  // rail renders from on a phone.
  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh settings",
    testId: "admin-settings-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-settings-tab" data-testid="admin-settings-tab">
      {/* The toolbar stays: unlike the tabs whose band was title-plus-refresh
          and nothing else, its subtitle names the scope of everything below
          (server-wide, not per-network), which the nav above does not say. */}
      <AdminToolbar title="Settings" subtitle="Server-wide upload, DCC and auto-away settings" />

      <div class="adm-scroll">
        <Show when={error()}>
          <span class="adm-field-error" role="alert" data-testid="admin-settings-error">
            error: {error()}
          </span>
        </Show>

        <Show when={settings() !== null} fallback={<AdminLoading message="loading settings…" />}>
          <form onSubmit={(e) => void onSave(e)} class="admin-settings-form" noValidate>
            <AdminCard
              hostsRefresh
              title="Uploads"
              subtitle="Applies to every network on this server"
            >
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

                <For each={uploadRows}>{numberRow}</For>
              </div>
            </AdminCard>

            {/* issue 2202 — its own card, not more rows in the upload one:
                the two families are separate closed key sets on the server
                and `global_cap_bytes` means a different budget in each, so
                a shared card would put two rows with the same meaning-word
                side by side under one heading. */}
            <AdminCard title="DCC" subtitle="Transfer ceilings for the DCC spool">
              <div class="adm-field-rows">
                <For each={dccRows}>{numberRow}</For>
              </div>
            </AdminCard>

            {/* issue 2359 — its own card: not an upload or DCC limit, and
                the one setting here every user SEES (their drawer's "use
                site default (…)" follows this value live). */}
            <AdminCard title="Auto-away" subtitle="Default for users who have not chosen one">
              <div class="adm-field-rows">
                <AdminField
                  label="Default delay"
                  for="admin-settings-auto-away-default"
                  error={
                    fieldError() === "auto_away.default_debounce_seconds"
                      ? "invalid value"
                      : undefined
                  }
                >
                  <select
                    id="admin-settings-auto-away-default"
                    data-testid="admin-settings-auto-away-default"
                    value={autoAwayDefault()}
                    onChange={(e) => setAutoAwayDefault(e.currentTarget.value)}
                    disabled={saving()}
                    classList={{
                      "admin-settings-field-error":
                        fieldError() === "auto_away.default_debounce_seconds",
                    }}
                  >
                    <option value="">{serverConfigLabel()}</option>
                    <option value="0">off</option>
                    <For each={AUTO_AWAY_PRESETS}>
                      {(preset) => <option value={String(preset.seconds)}>{preset.label}</option>}
                    </For>
                  </select>
                </AdminField>
              </div>
            </AdminCard>

            {/* One save for the whole form — the PUT carries both subtrees
                and the controller applies each independently. The footer
                sits OUTSIDE the cards for that reason: inside the upload
                one it would read as saving uploads alone. */}
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
                when={savedAt() !== null && !saving() && error() === null && fieldError() === null}
              >
                <span class="adm-field-hint" data-testid="admin-settings-saved">
                  saved
                </span>
              </Show>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
};

export default AdminSettingsTab;
