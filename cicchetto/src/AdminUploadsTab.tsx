import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminCard from "./admin/AdminCard";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { formatInstant } from "./admin/formatInstant";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminUpload,
  type AdminUploadsResponse,
  adminDeleteUpload,
  adminListUploads,
} from "./lib/api";
import { ApiError } from "./lib/apiError";
import { token } from "./lib/auth";
import { formatBytes } from "./lib/formatBytes";

// issue 2288 — Uploads admin tab. The moderation verb over attachments was
// already shipped on the server (`GET /admin/uploads` + `DELETE
// /admin/uploads/:id`, behind `:admin_authn`) and had no door in cic at all,
// so an operator asked to pull a file before its TTL had nothing to press.
// This tab is that door and nothing more: it lists what `index/2` already
// returns and wires one destructive action per LIVE row onto the existing
// DELETE.
//
// Two row classes out of one list. `index/2` deliberately includes
// soft-deleted rows — that listing IS the audit trail, so a moderated
// attachment stays on screen with its `deleted_at` instead of vanishing.
// A deleted row therefore carries NO delete button — and the reason is worse
// than a plain "it would fail", measured in the server: `Uploads.get_by_id/1`
// does NOT filter soft-deleted rows and `Uploads.soft_delete/2` short-circuits
// on a row that already carries a `deleted_at`, so a second DELETE unlinks
// nothing, writes nothing, and answers **204**. The operator would be told the
// work was done, about work that did not happen and cannot happen.
//
// What this tab does NOT do, deliberately: it does not replace the bytes with
// a 0-byte file. `GET /uploads/:slug` collapses every failure onto one 404
// ("No oracle", `uploads_controller.ex`), and a 200 with an empty body would
// re-introduce exactly the distinction that shape exists to deny — it would
// separate "moderated away" from "never existed" for anyone holding the link.
// Deleting already reaches the intended end state.
//
// The `[NNN]` handle sketched alongside this tab in the issue is NOT here.
// It is a wire + message-body change with an open design question (how the
// counter is namespaced so it can be short and stable at once), and it needs
// a ruling rather than a choice made inside a client slice. The slug is what
// an operator can match today, which is why it gets a column.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Post-mutation refresh: the delete re-reads the whole list rather than
// splicing the row locally. The server's projection is the only honest source
// — a soft-deleted row is still IN the list, in a different state, and cic
// does not originate state.

/**
 * A row is live while it carries no soft-delete marker.
 *
 * `expires_at` is NOT part of this: an expired row is still served and still
 * counts against the cap until the reaper actually unlinks it, and the whole
 * point of this surface is reaching such a row BEFORE the sweep does.
 * Deriving "gone" from the clock would hide exactly that row.
 */
export function uploadIsLive(u: AdminUpload): boolean {
  return u.deleted_at === null;
}

/**
 * The disk budget as one line: used, cap, and the share of the cap.
 *
 * `formatBytes` is the single cap/size spelling in cic (#411), so this reads
 * the same as every other size the operator sees. The share is DROPPED when
 * the cap is not a positive number — `used/0` renders as `Infinity%` and a
 * number that is not one is worse than no number.
 */
export function budgetLabel(liveBytes: number, capBytes: number): string {
  const used = `${formatBytes(liveBytes)} of ${formatBytes(capBytes)}`;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return used;
  return `${used} (${Math.round((liveBytes / capBytes) * 100)}%)`;
}

function deleteKey(id: string): string {
  return `delete:${id}`;
}

// `original_filename` is best-effort (the uploader may send none), so the name
// falls back to the slug — the one identifier every row has, and the one the
// posted link carries.
function displayName(u: AdminUpload): string {
  const name = u.original_filename?.trim() ?? "";
  return name === "" ? u.slug : name;
}

function expiryLabel(u: AdminUpload): string {
  // NULL expiry means the reaper never sweeps it. The column supports an
  // admin pin that no verb sets today, so this is rare — and worth naming
  // rather than rendering as a blank cell.
  return u.expires_at === null ? "never" : formatInstant(u.expires_at);
}

function stateLabel(u: AdminUpload): string {
  const at = u.deleted_at;
  return at === null ? "live" : `deleted ${formatInstant(at)}`;
}

const UPLOAD_COLUMNS = [
  "file",
  "slug",
  "type",
  "size",
  "subject",
  "expires",
  "state",
  "actions",
] as const;

const AdminUploadsTab: Component = () => {
  const [data, setData] = createSignal<AdminUploadsResponse | null>(null);
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const uploads = (): AdminUpload[] => data()?.uploads ?? [];

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      setData(await adminListUploads(t));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onDelete = async (u: AdminUpload): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteUpload(t, u.id);
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`delete (${u.slug}): ${code}`);
    } finally {
      setConfirmingKey(null);
    }
  };

  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh uploads list",
    testId: "admin-uploads-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-uploads-tab">
      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-uploads-error" />
        </Show>

        {/* The budget renders only once the server has answered: before that
            there is no number, and "0 bytes of 0 bytes" would be a lie that
            looks like a measurement. */}
        <Show when={data()}>
          {(d) => (
            <AdminCard
              title="Disk budget"
              subtitle="live bytes against the global upload cap — soft-deleted rows no longer count"
            >
              <p data-testid="admin-uploads-budget">
                {budgetLabel(d().live_bytes_sum, d().global_cap_bytes)}
              </p>
            </AdminCard>
          )}
        </Show>

        <Show when={data() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={data() !== null && uploads().length === 0}>
          <AdminEmpty message="no uploads" testId="admin-uploads-empty" />
        </Show>

        <Show when={uploads().length > 0}>
          <AdminCard
            hostsRefresh
            title="Registry"
            subtitle="moderated rows stay listed with their deletion time — this is the audit trail"
          >
            <AdminTable data-testid="admin-uploads-table">
              <thead>
                <tr>
                  <For each={UPLOAD_COLUMNS}>
                    {(col) => (
                      <th
                        class={
                          col === "file"
                            ? "adm-table-grow"
                            : col === "actions"
                              ? "adm-table-sticky-actions"
                              : undefined
                        }
                      >
                        {col}
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={uploads()}>
                  {(u) => (
                    <tr class="admin-uploads-row" data-testid={`admin-upload-row-${u.id}`}>
                      <td class="adm-cell-title">{displayName(u)}</td>
                      {/* The slug is how a moderator gets from a link in a
                          channel to this row — it is the only shared token
                          between the two, so it is a column and not a title. */}
                      <td data-label="slug">{u.slug}</td>
                      <td data-label="type">{u.mime}</td>
                      <td data-label="size">{formatBytes(u.bytes)}</td>
                      {/* No name resolution: the admin list carries the
                          subject's stable id and nothing else, and inventing
                          a lookup here would be a second source for something
                          the server does not say. */}
                      <td data-label="subject" title={u.subject_id}>
                        {u.subject_kind} · {u.subject_id}
                      </td>
                      <td data-label="expires">{expiryLabel(u)}</td>
                      <td data-label="state">{stateLabel(u)}</td>
                      <td class="adm-table-sticky-actions" data-label="actions">
                        <Show when={uploadIsLive(u)}>
                          <InlineConfirmButton
                            idleLabel="Delete"
                            confirmLabel="Confirm delete"
                            armed={confirmingKey() === deleteKey(u.id)}
                            onArm={() => setConfirmingKey(deleteKey(u.id))}
                            onConfirm={() => onDelete(u)}
                            testId={`admin-upload-delete-${u.id}`}
                            extraClass="delete-btn"
                          />
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

export default AdminUploadsTab;
