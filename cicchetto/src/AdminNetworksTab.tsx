import { type Component, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import AdminFacts from "./admin/AdminFacts";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import AdminToolbar, { AdminRefreshButton } from "./admin/AdminToolbar";
import InlineConfirmButton from "./InlineConfirmButton";
import { liveCountsByNetworkId } from "./lib/adminEvents";
import {
  type AdminFeaturedChannel,
  type AdminNetwork,
  type AdminNetworkCapsPatch,
  type AdminServer,
  ApiError,
  adminAddFeaturedChannel,
  adminAddServer,
  adminCreateNetwork,
  adminDeleteFeaturedChannel,
  adminDeleteNetwork,
  adminDeleteServer,
  adminListFeaturedChannels,
  adminListNetworks,
  adminListServers,
  adminPatchNetworkCaps,
  adminResetCircuit,
  adminRunReaper,
  adminUpdateFeaturedChannel,
  adminUpdateServer,
} from "./lib/api";
import { token } from "./lib/auth";
import { isAdminNarrow } from "./lib/theme";

// M-cluster M-10 — Networks admin tab. Operator surface for the
// admission caps + circuit-breaker recovery + on-demand visitor reap.
//
// Per-row controls:
//   * Inline number editors for `max_concurrent_visitor_sessions` +
//     `max_concurrent_user_sessions` + `max_per_ip` (post-U-1 the
//     network-total cap is split per subject; logic split lands in
//     U-2). Empty string == null (the "unlimited" sentinel per
//     `Networks.update_network_caps/2`'s three-valued contract).
//     Save fires PATCH with ONLY the changed keys (server contract:
//     unsupplied keys keep their value; sending all keys on every
//     edit would silently overwrite a concurrent admin's edit to the
//     other cap — CRIT-1 of the M-10 review).
//   * Reset Circuit (InlineConfirmButton) — only rendered when
//     `circuit_state !== null`. POST /admin/circuit/:id/reset.
//
// Tab-header controls:
//   * Refresh (↻) — re-calls GET; clears in-flight per-row edits
//     because the server state might have moved under us.
//   * Sweep visitors (InlineConfirmButton) — POST /admin/reaper/run.
//     Labelled for what it DOES, not for the internal name of the
//     process that does it: "Force Reap" told an operator nothing.
//     Transient success line under the header shows the swept count.
//
// Post-mutation refresh: every server mutation (Save, Reset Circuit)
// triggers a full list re-fetch — mirrors M-9b's `runAction` pattern.
// Live BEAM state can move under us between the verb landing and the
// next render (other admin tripping the breaker, another visitor
// arriving against a cap), so the only honest source of truth is the
// server's post-mutation projection (MED-5 of M-10 review).
//
// Per `feedback_no_localized_strings_server_side`: server emits typed
// `circuit_state` (`state: "open" | "closed"` + integer counts +
// seconds); cic owns every human-readable rendering ("OPEN (retry in
// 12s)" / "—" / "Sweep visitors" / etc).
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Per `feedback_solidjs_for_ref_leak`: NO let-bound refs inside the
// `<For>` row. Per-row dirty state lives in a top-level store keyed
// on slug; handlers close over slug (string copy), not DOM refs.

type RowEdit = {
  max_concurrent_visitor_sessions: string;
  max_concurrent_user_sessions: string;
  max_per_ip: string;
};

type ParseResult = { ok: true; value: number | null } | { ok: false };

// Max admission cap. 2^31-1 is the SQLite INTEGER 4-byte signed cap;
// any operator who needs more is doing something else wrong. Guards
// against the operator pasting `99999999999999999999` which
// `Number.parseInt` truncates to a JS-float that JSON-encodes lossily
// (HIGH-2 of M-10 review).
const MAX_CAP = 2 ** 31 - 1;

// `field` → human label. Mirrors the table `<th>` text so screen-
// reader users get the same wording sighted users see (MED-8 of
// M-10 review).
const FIELD_LABELS: Record<keyof RowEdit, string> = {
  max_concurrent_visitor_sessions: "max visitor sessions",
  max_concurrent_user_sessions: "max user sessions",
  max_per_ip: "max per ip",
};

const FIELD_TEST_ID_SLUG: Record<keyof RowEdit, string> = {
  max_concurrent_visitor_sessions: "max-visitor-sessions",
  max_concurrent_user_sessions: "max-user-sessions",
  max_per_ip: "max-per-ip",
};

// slug + the six secondary columns + actions. Feeds the detail row's
// `colspan` at desktop width; on a phone only slug + actions survive.
const NETWORK_COLUMNS = 8;

function reapKey(): string {
  return "force-reap";
}

function resetKey(slug: string): string {
  return `reset:${slug}`;
}

function renderCap(cap: number | null): string {
  return cap === null ? "∞" : String(cap);
}

type LiveCountsView = { visitors: number; users: number };

// U-5: overlay live :cap_counts_changed counts on top of the
// server-fetched cold-state baseline. Cold state comes from
// `GET /admin/networks` (`net.live_counts.{visitors,users}`); live
// updates flow through the adminEvents `liveCountsByNetworkId`
// signal each time the server emits a :cap_counts_changed broadcast
// (one per session lifecycle transition).
//
// S3 of U-5 review: caps are NEVER read from the live overlay.
// The PATCH /admin/networks/:id response (refetch) is the cap
// authority; live broadcast caps could lag behind a cap edit if
// the network has zero session-lifecycle churn between PATCH +
// next broadcast. Keep caps cold-only; overlay counts only.
function effectiveLive(net: AdminNetwork): LiveCountsView {
  const overlay = liveCountsByNetworkId()[net.id];
  if (overlay !== undefined) {
    return { visitors: overlay.visitors, users: overlay.users };
  }
  return { visitors: net.live_counts.visitors, users: net.live_counts.users };
}

const AdminNetworksTab: Component = () => {
  const [networks, setNetworks] = createSignal<AdminNetwork[] | null>(null);
  // Per-row edit state keyed by slug. Initialized on every fetch from
  // the server-echoed cap values. Dirty := edit !== server-echoed.
  // Store (not signal map) so per-row input writes don't re-render
  // sibling rows.
  const [edits, setEdits] = createStore<Record<string, RowEdit>>({});
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [reapResult, setReapResult] = createSignal<{ count: number; at: string } | null>(null);

  // Bucket 5 — Create network form (singleton at header).
  const [createSlug, setCreateSlug] = createSignal<string>("");
  const [creating, setCreating] = createSignal(false);

  // Bucket 5 — Servers disclosure per network. `expandedNetworkId` is
  // the open row's id or null. `serversByNetworkId` caches the fetched
  // list per network so re-expanding doesn't refetch. `serverFormByNetworkId`
  // holds the add-server form state per network.
  const [expandedNetworkId, setExpandedNetworkId] = createSignal<number | null>(null);
  const [serversByNetworkId, setServersByNetworkId] = createStore<Record<number, AdminServer[]>>(
    {},
  );
  const [serverForm, setServerForm] = createStore<
    // #266 — `source` is the optional per-network outbound source bind (empty
    // string = unset).
    Record<number, { host: string; port: string; tls: boolean; source: string }>
  >({});
  const [serverConfirmKey, setServerConfirmKey] = createSignal<string | null>(null);

  // #85 — Featured-channels disclosure, sibling to servers. Same
  // per-network cache + add-form-state + delete-confirm pattern.
  const [featuredByNetworkId, setFeaturedByNetworkId] = createStore<
    Record<number, AdminFeaturedChannel[]>
  >({});
  const [featuredForm, setFeaturedForm] = createStore<
    Record<number, { name: string; description: string; position: string }>
  >({});
  const [featuredConfirmKey, setFeaturedConfirmKey] = createSignal<string | null>(null);
  const emptyFeaturedForm = () => ({ name: "", description: "", position: "0" });

  const seedEditsFromServer = (rows: AdminNetwork[]): void => {
    setEdits(
      produce((draft) => {
        for (const k of Object.keys(draft)) delete draft[k];
        for (const n of rows) {
          draft[n.slug] = {
            max_concurrent_visitor_sessions: capToInput(n.max_concurrent_visitor_sessions),
            max_concurrent_user_sessions: capToInput(n.max_concurrent_user_sessions),
            max_per_ip: capToInput(n.max_per_ip),
          };
        }
      }),
    );
  };

  // The detail renders INSIDE the `<For>`, beneath the row it belongs
  // to (#1074), so it needs no derived "which network is this about":
  // the row is right there, and a network deleted by another admin
  // takes its own panel with it.

  // Column count for the detail row's `colspan`. Below the console's
  // breakpoint the six secondary columns are gone, so the row is slug +
  // actions.
  //
  // #1223 — the gate is `isAdminNarrow()` (899px), not `isMobile()`
  // (768px): the split has to agree with the CSS that stacks the table,
  // or the 769-899 band gets a card whose columns are still inline while
  // every other tab has already moved them into the panel.
  const networkColumns = (): number => (isAdminNarrow() ? 2 : NETWORK_COLUMNS);

  // The two cells that move between the row and the detail depending on
  // width. ONE definition each: the cap editor is a live control, and a
  // second copy of it would mean two elements answering to one test id
  // and two inputs writing the same draft.
  const capEditor = (net: AdminNetwork, field: keyof RowEdit): JSX.Element => (
    <CapInput
      slug={net.slug}
      field={field}
      value={edits[net.slug]?.[field] ?? ""}
      onInput={(v) => onEditCap(net.slug, field, v)}
    />
  );

  const liveCount = (net: AdminNetwork, kind: "visitors" | "users"): JSX.Element => {
    const cap = (): number | null =>
      kind === "visitors" ? net.max_concurrent_visitor_sessions : net.max_concurrent_user_sessions;
    return (
      <span
        data-testid={`admin-network-live-${kind}-${net.slug}`}
        title={`${effectiveLive(net)[kind]} live ${
          kind === "visitors" ? "visitor" : "user"
        } sessions of ${renderCap(cap())} cap`}
      >
        {effectiveLive(net)[kind]}/{renderCap(cap())}
      </span>
    );
  };

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      const next = await adminListNetworks(t);
      setNetworks(next);
      seedEditsFromServer(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onEditCap = (slug: string, field: keyof RowEdit, value: string): void => {
    setEdits(
      produce((draft) => {
        const row = draft[slug];
        if (row === undefined) return;
        row[field] = value;
      }),
    );
  };

  const onSave = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    const edit = edits[net.slug];
    if (edit === undefined) return;
    const patch = buildPatchBody(net, edit);
    if (patch === null) {
      // Save was wired correctly (disabled unless dirty + valid) so
      // this branch fires only on a keyboard-bypass race. Don't
      // silently swallow — surface to the operator (HIGH-4 of M-10
      // review).
      setError(`save: invalid cap value for ${net.slug}`);
      return;
    }
    if (Object.keys(patch).length === 0) return; // pristine bypass — no-op
    setError(null);
    try {
      await adminPatchNetworkCaps(t, net.slug, patch);
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`save: ${code}`);
    }
  };

  const onResetCircuit = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminResetCircuit(t, net.id);
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`reset: ${code}`);
      setConfirmingKey(null);
    }
  };

  const onForceReap = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      const result = await adminRunReaper(t);
      setReapResult({ count: result.swept_count, at: result.swept_at });
      setConfirmingKey(null);
      // Reaper may have deleted visitors but Networks rows are operator
      // intent — no row count change expected. We DON'T re-fetch the
      // Networks list (visitor counts surface in the Visitors tab, not
      // here).
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`reap: ${code}`);
      setConfirmingKey(null);
    }
  };

  const onCreateNetwork = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const slug = createSlug().trim();
    if (slug === "") return;
    setCreating(true);
    setError(null);
    try {
      await adminCreateNetwork(t, { slug });
      setCreateSlug("");
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "create_failed";
      setError(`create: ${code}`);
    } finally {
      setCreating(false);
    }
  };

  const onDeleteNetwork = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteNetwork(t, net.id);
      await refresh();
      setConfirmingKey(null);
    } catch (err) {
      if (err instanceof ApiError) {
        const count =
          typeof err.info.credential_count === "number" ? err.info.credential_count : null;
        if (err.code === "credentials_present" && count !== null) {
          setError(`delete (${net.slug}): ${count} bound credential(s) — unbind first`);
        } else if (err.code === "scrollback_present") {
          setError(`delete (${net.slug}): scrollback present — purge first`);
        } else {
          setError(`delete (${net.slug}): ${err.code}`);
        }
      } else {
        setError(`delete (${net.slug}): request_failed`);
      }
      setConfirmingKey(null);
    }
  };

  const onToggleExpand = async (net: AdminNetwork): Promise<void> => {
    if (expandedNetworkId() === net.id) {
      setExpandedNetworkId(null);
      return;
    }
    setExpandedNetworkId(net.id);
    setServerForm(
      produce((draft) => {
        if (draft[net.id] === undefined) {
          draft[net.id] = { host: "", port: "6697", tls: true, source: "" };
        }
      }),
    );
    setFeaturedForm(
      produce((draft) => {
        if (draft[net.id] === undefined) draft[net.id] = emptyFeaturedForm();
      }),
    );
    // First-open fetch (cache thereafter).
    if (serversByNetworkId[net.id] === undefined) {
      const t = token();
      if (t === null) return;
      try {
        const list = await adminListServers(t, net.id);
        setServersByNetworkId(
          produce((draft) => {
            draft[net.id] = list;
          }),
        );
      } catch (err) {
        const code = err instanceof ApiError ? err.code : "request_failed";
        setError(`servers (${net.slug}): ${code}`);
      }
    }
    if (featuredByNetworkId[net.id] === undefined) await refreshFeatured(net);
  };

  const refreshFeatured = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    try {
      const list = await adminListFeaturedChannels(t, net.id);
      setFeaturedByNetworkId(
        produce((draft) => {
          draft[net.id] = list;
        }),
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`featured (${net.slug}): ${code}`);
    }
  };

  const onAddFeaturedChannel = async (net: AdminNetwork, e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const f = featuredForm[net.id];
    if (f === undefined || f.name.trim() === "") return;
    const position = Number.parseInt(f.position, 10);
    if (!Number.isFinite(position) || position < 0) {
      setError(`add featured: invalid position`);
      return;
    }
    setError(null);
    try {
      await adminAddFeaturedChannel(t, net.id, {
        name: f.name.trim(),
        description: f.description.trim() === "" ? null : f.description.trim(),
        position,
      });
      setFeaturedForm(
        produce((draft) => {
          draft[net.id] = emptyFeaturedForm();
        }),
      );
      await refreshFeatured(net);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`add featured (${net.slug}): ${code}`);
    }
  };

  const onToggleFeaturedEnabled = async (
    net: AdminNetwork,
    fc: AdminFeaturedChannel,
  ): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUpdateFeaturedChannel(t, net.id, fc.id, { enabled: !fc.enabled });
      await refreshFeatured(net);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`update featured (${fc.name}): ${code}`);
    }
  };

  const onDeleteFeaturedChannel = async (
    net: AdminNetwork,
    fc: AdminFeaturedChannel,
  ): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteFeaturedChannel(t, net.id, fc.id);
      await refreshFeatured(net);
      setFeaturedConfirmKey(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`delete featured (${fc.name}): ${code}`);
      setFeaturedConfirmKey(null);
    }
  };

  const refreshServers = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    try {
      const list = await adminListServers(t, net.id);
      setServersByNetworkId(
        produce((draft) => {
          draft[net.id] = list;
        }),
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`servers (${net.slug}): ${code}`);
    }
  };

  const onAddServer = async (net: AdminNetwork, e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const f = serverForm[net.id];
    if (f === undefined || f.host.trim() === "") return;
    const port = Number.parseInt(f.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setError(`add server: invalid port`);
      return;
    }
    setError(null);
    // #266 — an empty source field means "unset" (omit), a filled one pins the
    // per-network outbound egress. Non-local literals are rejected server-side
    // (422 source_not_local) and surface in the shared error banner.
    const source = f.source.trim();
    try {
      await adminAddServer(t, net.id, {
        host: f.host.trim(),
        port,
        tls: f.tls,
        ...(source === "" ? {} : { source_address: source }),
      });
      setServerForm(
        produce((draft) => {
          draft[net.id] = { host: "", port: "6697", tls: true, source: "" };
        }),
      );
      await refreshServers(net);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`add server (${net.slug}): ${code}`);
    }
  };

  const onToggleServerTls = async (net: AdminNetwork, s: AdminServer): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUpdateServer(t, net.id, s.id, { tls: !s.tls });
      await refreshServers(net);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`update server (${s.host}:${s.port}): ${code}`);
    }
  };

  // #266 — set/clear an existing server's per-network source_address. An empty
  // input clears it (JSON null); a filled one pins it. Non-local literals are
  // rejected server-side and surface in the shared error banner.
  const onSaveServerSource = async (
    net: AdminNetwork,
    s: AdminServer,
    raw: string,
  ): Promise<void> => {
    const t = token();
    if (t === null) return;
    const trimmed = raw.trim();
    // No-op if unchanged (empty stays cleared / same literal).
    if (trimmed === (s.source_address ?? "")) return;
    setError(null);
    try {
      await adminUpdateServer(t, net.id, s.id, {
        source_address: trimmed === "" ? null : trimmed,
      });
      await refreshServers(net);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`set source (${s.host}:${s.port}): ${code}`);
    }
  };

  const onDeleteServer = async (net: AdminNetwork, s: AdminServer): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteServer(t, net.id, s.id);
      await refreshServers(net);
      setServerConfirmKey(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`delete server (${s.host}:${s.port}): ${code}`);
      setServerConfirmKey(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-networks-tab">
      <AdminToolbar
        title="Networks"
        subtitle="caps are DB intent, the live counts beside them come from the Registry — Sweep visitors runs the expired-visitor reaper now"
        actions={
          <>
            <InlineConfirmButton
              idleLabel="Sweep visitors"
              confirmLabel="Confirm sweep"
              armed={confirmingKey() === reapKey()}
              onArm={() => setConfirmingKey(reapKey())}
              onConfirm={onForceReap}
              testId="admin-networks-force-reap"
              extraClass="force-reap-btn"
            />
            {/* Networks KEEPS its toolbar — it carries the Sweep-visitors
                verb and a line explaining the caps columns, which is more
                than the tab's own name. So its refresh stays here in full
                rather than moving to the pane header like the tabs whose
                toolbar was title-plus-refresh and nothing else. */}
            <AdminRefreshButton
              onClick={() => {
                void refresh();
              }}
              busy={loading()}
              label="refresh networks list"
              testId="admin-networks-refresh"
            />
          </>
        }
      />

      <div class="adm-scroll">
        <Show when={reapResult() !== null}>
          <p class="adm-success" data-testid="admin-networks-reap-result">
            reaper swept {reapResult()?.count} visitor(s)
          </p>
        </Show>

        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-networks-error" />
        </Show>

        <AdminCard title="Create network" subtitle="POST /admin/networks">
          <form
            class="admin-networks-create-form adm-form-row"
            onSubmit={(e) => {
              void onCreateNetwork(e);
            }}
            data-testid="admin-networks-create-form"
          >
            <input
              placeholder="slug"
              aria-label="slug"
              type="text"
              value={createSlug()}
              onInput={(e) => setCreateSlug((e.currentTarget as HTMLInputElement).value)}
              data-testid="admin-networks-create-slug"
              required
            />
            <button
              type="submit"
              class="adm-btn"
              disabled={creating() || createSlug().trim() === ""}
              data-testid="admin-networks-create-submit"
            >
              Create
            </button>
          </form>
        </AdminCard>

        <Show when={networks() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={networks() !== null && (networks() ?? []).length === 0}>
          <AdminEmpty message="no networks" testId="admin-networks-empty" />
        </Show>

        <Show when={networks() !== null && (networks() ?? []).length > 0}>
          <AdminCard
            title="Networks"
            subtitle="expand a row for its server pool and featured channels"
          >
            <AdminTable data-testid="admin-networks-table">
              <thead>
                <tr>
                  <th class="adm-table-grow">slug</th>
                  {/* #1074 — dropped on a phone and shown in the row's
                      detail instead, like every other tab. A JSX branch
                      rather than the `.adm-col-detail` display:none the
                      read-only tabs use: three of these cells are cap
                      EDITORS, and the detail has to render the control
                      itself, not a copy of its value. Two live controls
                      with one test id is not a layout, it is a bug. */}
                  <Show when={!isAdminNarrow()}>
                    <th>visitors (live/cap)</th>
                    <th>max visitor sessions</th>
                    <th>users (live/cap)</th>
                    <th>max user sessions</th>
                    <th>max per ip</th>
                    <th>circuit</th>
                  </Show>
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={networks() ?? []}>
                  {(net) => (
                    <>
                      <tr class="admin-networks-row" data-testid={`admin-network-row-${net.slug}`}>
                        <td class="adm-cell-title">
                          <button
                            type="button"
                            class="admin-network-expand-btn"
                            onClick={() => {
                              void onToggleExpand(net);
                            }}
                            data-testid={`admin-network-expand-${net.slug}`}
                            aria-expanded={expandedNetworkId() === net.id}
                          >
                            {expandedNetworkId() === net.id ? "▾" : "▸"} {net.slug}
                          </button>
                        </td>
                        <Show when={!isAdminNarrow()}>
                          <td data-label="visitors">{liveCount(net, "visitors")}</td>
                          <td data-label="max visitors">
                            {capEditor(net, "max_concurrent_visitor_sessions")}
                          </td>
                          <td data-label="users">{liveCount(net, "users")}</td>
                          <td data-label="max users">
                            {capEditor(net, "max_concurrent_user_sessions")}
                          </td>
                          <td data-label="max per ip">{capEditor(net, "max_per_ip")}</td>
                          <td data-label="circuit">
                            <CircuitBadge net={net} />
                          </td>
                        </Show>
                        <td
                          class="admin-networks-actions adm-table-sticky-actions"
                          data-label="actions"
                        >
                          <button
                            type="button"
                            class="adm-btn adm-btn--ok"
                            disabled={!isDirtyAndValid(net, edits[net.slug])}
                            onClick={() => {
                              void onSave(net);
                            }}
                            data-testid={`admin-network-save-${net.slug}`}
                          >
                            Save
                          </button>
                          <Show when={net.circuit_state !== null}>
                            <InlineConfirmButton
                              idleLabel="Reset Circuit"
                              confirmLabel="Confirm reset circuit"
                              armed={confirmingKey() === resetKey(net.slug)}
                              onArm={() => setConfirmingKey(resetKey(net.slug))}
                              onConfirm={() => onResetCircuit(net)}
                              testId={`admin-network-reset-circuit-${net.slug}`}
                              extraClass="reset-circuit-btn"
                            />
                          </Show>
                          <InlineConfirmButton
                            idleLabel="Delete"
                            confirmLabel="Confirm delete"
                            armed={confirmingKey() === `delete:${net.slug}`}
                            onArm={() => setConfirmingKey(`delete:${net.slug}`)}
                            onConfirm={() => onDeleteNetwork(net)}
                            testId={`admin-network-delete-${net.slug}`}
                            extraClass="delete-btn"
                          />
                        </td>
                      </tr>
                      <Show when={expandedNetworkId() === net.id}>
                        <AdminDetailPanel
                          title={net.slug}
                          subtitle="server pool and featured channels for this network"
                          onClose={() => setExpandedNetworkId(null)}
                          closeLabel={`collapse ${net.slug}`}
                          columns={networkColumns()}
                          data-testid={`admin-network-servers-${net.slug}`}
                        >
                          {/* The columns the row drops on a phone. The cap
                              editors are the SAME controls, relocated —
                              there is no read-only copy of them anywhere,
                              so editing a cap stays possible on a phone
                              and Save stays up on the row. */}
                          <Show when={isAdminNarrow()}>
                            <AdminFacts
                              facts={[
                                {
                                  label: "visitors (live/cap)",
                                  value: liveCount(net, "visitors"),
                                },
                                {
                                  label: "max visitor sessions",
                                  value: capEditor(net, "max_concurrent_visitor_sessions"),
                                },
                                { label: "users (live/cap)", value: liveCount(net, "users") },
                                {
                                  label: "max user sessions",
                                  value: capEditor(net, "max_concurrent_user_sessions"),
                                },
                                { label: "max per ip", value: capEditor(net, "max_per_ip") },
                                { label: "circuit", value: <CircuitBadge net={net} /> },
                              ]}
                            />
                          </Show>
                          <ServersDisclosure
                            net={net}
                            servers={serversByNetworkId[net.id] ?? []}
                            form={
                              serverForm[net.id] ?? {
                                host: "",
                                port: "6697",
                                tls: true,
                                source: "",
                              }
                            }
                            onFormChange={(patch) =>
                              setServerForm(
                                produce((draft) => {
                                  const cur = draft[net.id] ?? {
                                    host: "",
                                    port: "6697",
                                    tls: true,
                                    source: "",
                                  };
                                  draft[net.id] = { ...cur, ...patch };
                                }),
                              )
                            }
                            onAddServer={(e) => {
                              void onAddServer(net, e);
                            }}
                            onToggleTls={(s) => {
                              void onToggleServerTls(net, s);
                            }}
                            onSaveSource={(s, raw) => {
                              void onSaveServerSource(net, s, raw);
                            }}
                            confirmingServerKey={serverConfirmKey()}
                            onArmServerDelete={(key) => setServerConfirmKey(key)}
                            onDeleteServer={(s) => {
                              void onDeleteServer(net, s);
                            }}
                          />
                          <FeaturedChannelsDisclosure
                            net={net}
                            featured={featuredByNetworkId[net.id] ?? []}
                            form={featuredForm[net.id] ?? emptyFeaturedForm()}
                            onFormChange={(patch) =>
                              setFeaturedForm(
                                produce((draft) => {
                                  const cur = draft[net.id] ?? emptyFeaturedForm();
                                  draft[net.id] = { ...cur, ...patch };
                                }),
                              )
                            }
                            onAddFeatured={(e) => {
                              void onAddFeaturedChannel(net, e);
                            }}
                            onToggleEnabled={(fc) => {
                              void onToggleFeaturedEnabled(net, fc);
                            }}
                            confirmingFeaturedKey={featuredConfirmKey()}
                            onArmFeaturedDelete={(key) => setFeaturedConfirmKey(key)}
                            onDeleteFeatured={(fc) => {
                              void onDeleteFeaturedChannel(net, fc);
                            }}
                          />
                        </AdminDetailPanel>
                      </Show>
                    </>
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

const CapInput: Component<{
  slug: string;
  field: keyof RowEdit;
  value: string;
  onInput: (value: string) => void;
}> = (props) => {
  const testId = `admin-network-${FIELD_TEST_ID_SLUG[props.field]}-${props.slug}`;
  const invalid = (): boolean => props.value.trim() !== "" && !parseCap(props.value).ok;
  return (
    <input
      type="number"
      class="adm-cap-input"
      min="0"
      step="1"
      value={props.value}
      placeholder="unlimited"
      onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
      data-testid={testId}
      aria-label={`${FIELD_LABELS[props.field]} for ${props.slug}`}
      aria-invalid={invalid()}
    />
  );
};

// Admin redesign (2026-08-07 plan, Layer 4) — one of the four badge
// idioms the shared `AdminBadge` replaces. The `.circuit-badge` classes
// carried hardcoded hexes, so the circuit state was the one status in
// the pane that ignored the active theme.
//
// `none` is NEUTRAL rather than ok: a network with no circuit row has
// never tripped the breaker, which is not the same claim as "the
// breaker is closed" and must not read as one.
const CircuitBadge: Component<{ net: AdminNetwork }> = (props) => {
  if (props.net.circuit_state === null) {
    return (
      <AdminBadge tone="neutral" testId={`admin-network-circuit-${props.net.slug}`}>
        —
      </AdminBadge>
    );
  }
  const c = props.net.circuit_state;
  return (
    <AdminBadge
      tone={c.state === "open" ? "danger" : "ok"}
      testId={`admin-network-circuit-${props.net.slug}`}
    >
      <span title={`failures=${c.failure_count}`}>
        {renderCircuitLabel(c.state, c.retry_after_seconds)}
      </span>
    </AdminBadge>
  );
};

function renderCircuitLabel(state: "open" | "closed", retryAfterSeconds: number): string {
  if (state === "open") return `OPEN (retry in ${retryAfterSeconds}s)`;
  return state;
}

function capToInput(cap: number | null): string {
  return cap === null ? "" : String(cap);
}

// Strict cap parser. Three states:
//   * `{ok: true, value: null}`   — empty input, operator means "unlimited"
//   * `{ok: true, value: N>=0}`   — valid integer within safe range
//   * `{ok: false}`               — non-integer, negative, or out-of-range
//
// `^\d+$` rejects `"-3"`, `"1e3"`, `"2.5"`, etc. Browser `<input
// type=number>` can emit those even though `min=0 step=1` are set —
// invalid input collapses to a CapInput aria-invalid flag, and Save
// stays disabled (HIGH-3 of M-10 review). MAX_CAP guards JS-int
// truncation on huge values (HIGH-2).
function parseCap(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n > MAX_CAP) return { ok: false };
  return { ok: true, value: n };
}

// Build the PATCH body containing ONLY keys whose value diverges from
// the server-echoed row. Server contract is keys-optional: unsupplied
// keys keep their current value. Returns null if ANY field fails
// validation (Save should be disabled in that case); returns an empty
// object if the row is pristine. CRIT-1 of M-10 review.
function buildPatchBody(net: AdminNetwork, edit: RowEdit): AdminNetworkCapsPatch | null {
  const visitorSessions = parseCap(edit.max_concurrent_visitor_sessions);
  if (!visitorSessions.ok) return null;
  const userSessions = parseCap(edit.max_concurrent_user_sessions);
  if (!userSessions.ok) return null;
  const perIp = parseCap(edit.max_per_ip);
  if (!perIp.ok) return null;
  const body: AdminNetworkCapsPatch = {};
  if (visitorSessions.value !== net.max_concurrent_visitor_sessions) {
    body.max_concurrent_visitor_sessions = visitorSessions.value;
  }
  if (userSessions.value !== net.max_concurrent_user_sessions) {
    body.max_concurrent_user_sessions = userSessions.value;
  }
  if (perIp.value !== net.max_per_ip) {
    body.max_per_ip = perIp.value;
  }
  return body;
}

function isDirtyAndValid(net: AdminNetwork, edit: RowEdit | undefined): boolean {
  if (edit === undefined) return false;
  const body = buildPatchBody(net, edit);
  if (body === null) return false;
  return Object.keys(body).length > 0;
}

// Servers disclosure: per-network add-server form + list with
// inline TLS toggle and delete-confirm per row. State lives in
// the parent so refresh cascades into the same draft (parent
// owns the refetch trigger).
const ServersDisclosure: Component<{
  net: AdminNetwork;
  servers: AdminServer[];
  form: { host: string; port: string; tls: boolean; source: string };
  onFormChange: (
    patch: Partial<{ host: string; port: string; tls: boolean; source: string }>,
  ) => void;
  onAddServer: (e: Event) => void;
  onToggleTls: (s: AdminServer) => void;
  onSaveSource: (s: AdminServer, raw: string) => void;
  confirmingServerKey: string | null;
  onArmServerDelete: (key: string | null) => void;
  onDeleteServer: (s: AdminServer) => void;
}> = (props) => {
  return (
    <div class="admin-network-servers-disclosure adm-subsection">
      <h4 class="adm-subsection-title">Servers</h4>
      <form
        class="admin-network-server-add-form adm-form-row"
        onSubmit={props.onAddServer}
        data-testid={`admin-network-add-server-form-${props.net.slug}`}
      >
        <input
          placeholder="host"
          aria-label="host"
          type="text"
          value={props.form.host}
          onInput={(e) => props.onFormChange({ host: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-server-host-${props.net.slug}`}
          required
        />
        <input
          placeholder="port"
          aria-label="port"
          type="number"
          min="1"
          max="65535"
          value={props.form.port}
          onInput={(e) => props.onFormChange({ port: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-server-port-${props.net.slug}`}
          required
        />
        <label class="adm-check">
          <input
            type="checkbox"
            checked={props.form.tls}
            onChange={(e) =>
              props.onFormChange({ tls: (e.currentTarget as HTMLInputElement).checked })
            }
            data-testid={`admin-network-add-server-tls-${props.net.slug}`}
          />
          TLS
        </label>
        <input
          placeholder="source"
          aria-label="source"
          type="text"
          value={props.form.source}
          onInput={(e) =>
            props.onFormChange({ source: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-network-add-server-source-${props.net.slug}`}
        />
        <button
          type="submit"
          class="adm-btn"
          disabled={props.form.host.trim() === ""}
          data-testid={`admin-network-add-server-submit-${props.net.slug}`}
        >
          Add server
        </button>
      </form>
      <Show when={props.servers.length === 0}>
        <AdminEmpty message="no servers" testId={`admin-network-servers-empty-${props.net.slug}`} />
      </Show>
      <Show when={props.servers.length > 0}>
        <AdminTable
          class="admin-network-servers-table adm-table--stack"
          data-testid={`admin-network-servers-table-${props.net.slug}`}
        >
          <thead>
            <tr>
              {/* host and port were two columns for one fact — a server
                  IS `host:port`, and splitting it spent a column to say
                  nothing. Merged on every viewport. The rest stay real
                  columns: this table STACKS on a phone rather than
                  dropping anything (`adm-table--stack`). */}
              <th class="adm-table-grow">host:port</th>
              <th>tls</th>
              <th>priority</th>
              <th>enabled</th>
              <th>source</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.servers}>
              {(s) => {
                // #266 — per-row source editor. Seeded from the current source
                // (re-seeded when a refetch replaces the row object). Empty on
                // save clears it; a filled literal pins it (server rejects a
                // non-local literal → shared error banner).
                const [sourceDraft, setSourceDraft] = createSignal(s.source_address ?? "");
                return (
                  <tr data-testid={`admin-network-server-row-${props.net.slug}-${s.id}`}>
                    <td data-label="host">
                      {s.host}:{s.port}
                    </td>
                    <td data-label="tls">{s.tls ? "yes" : "no"}</td>
                    <td data-label="priority">{s.priority}</td>
                    <td data-label="enabled">{s.enabled ? "yes" : "no"}</td>
                    <td data-label="source">
                      <input
                        type="text"
                        placeholder="unset"
                        value={sourceDraft()}
                        onInput={(e) => setSourceDraft((e.currentTarget as HTMLInputElement).value)}
                        data-testid={`admin-network-server-source-input-${props.net.slug}-${s.id}`}
                        aria-label={`outbound source for ${s.host}:${s.port}`}
                      />
                      <button
                        type="button"
                        class="adm-btn adm-btn--ok"
                        onClick={() => props.onSaveSource(s, sourceDraft())}
                        data-testid={`admin-network-server-source-save-${props.net.slug}-${s.id}`}
                      >
                        Save
                      </button>
                    </td>
                    <td data-label="actions">
                      <button
                        type="button"
                        class={`adm-btn ${s.tls ? "" : "adm-btn--secure"}`.trim()}
                        onClick={() => props.onToggleTls(s)}
                        data-testid={`admin-network-server-toggle-tls-${props.net.slug}-${s.id}`}
                      >
                        {s.tls ? "Disable TLS" : "Enable TLS"}
                      </button>
                      <InlineConfirmButton
                        idleLabel="Delete"
                        confirmLabel="Confirm delete"
                        armed={props.confirmingServerKey === `${props.net.id}:${s.id}`}
                        onArm={() => props.onArmServerDelete(`${props.net.id}:${s.id}`)}
                        onConfirm={() => props.onDeleteServer(s)}
                        testId={`admin-network-server-delete-${props.net.slug}-${s.id}`}
                        extraClass="delete-btn"
                      />
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </AdminTable>
      </Show>
    </div>
  );
};

// #85 — operator-curated featured channels per network. Clone of
// ServersDisclosure (sibling sub-resource); fields name/description/
// position, toggle-enabled + delete. Same data-testid scheme.
const FeaturedChannelsDisclosure: Component<{
  net: AdminNetwork;
  featured: AdminFeaturedChannel[];
  form: { name: string; description: string; position: string };
  onFormChange: (patch: Partial<{ name: string; description: string; position: string }>) => void;
  onAddFeatured: (e: Event) => void;
  onToggleEnabled: (fc: AdminFeaturedChannel) => void;
  confirmingFeaturedKey: string | null;
  onArmFeaturedDelete: (key: string | null) => void;
  onDeleteFeatured: (fc: AdminFeaturedChannel) => void;
}> = (props) => {
  return (
    <div class="admin-network-featured-disclosure adm-subsection">
      <h4 class="admin-network-featured-title adm-subsection-title">Featured channels</h4>
      <form
        class="admin-network-featured-add-form adm-form-row"
        onSubmit={props.onAddFeatured}
        data-testid={`admin-network-add-featured-form-${props.net.slug}`}
      >
        <input
          aria-label="channel"
          type="text"
          placeholder="#channel"
          value={props.form.name}
          onInput={(e) => props.onFormChange({ name: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-featured-name-${props.net.slug}`}
          required
        />
        <input
          placeholder="description"
          aria-label="description"
          type="text"
          value={props.form.description}
          onInput={(e) =>
            props.onFormChange({ description: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-network-add-featured-description-${props.net.slug}`}
        />
        <input
          placeholder="position"
          aria-label="position"
          type="number"
          min="0"
          value={props.form.position}
          onInput={(e) =>
            props.onFormChange({ position: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-network-add-featured-position-${props.net.slug}`}
        />
        <button
          type="submit"
          class="adm-btn"
          disabled={props.form.name.trim() === ""}
          data-testid={`admin-network-add-featured-submit-${props.net.slug}`}
        >
          Add featured
        </button>
      </form>
      <Show when={props.featured.length === 0}>
        <AdminEmpty
          message="no featured channels"
          testId={`admin-network-featured-empty-${props.net.slug}`}
        />
      </Show>
      <Show when={props.featured.length > 0}>
        <AdminTable
          class="admin-network-featured-table adm-table--stack"
          data-testid={`admin-network-featured-table-${props.net.slug}`}
        >
          <thead>
            <tr>
              <th class="adm-table-grow">channel</th>
              <th>description</th>
              <th>position</th>
              <th>enabled</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.featured}>
              {(fc) => (
                <tr data-testid={`admin-network-featured-row-${props.net.slug}-${fc.id}`}>
                  <td data-label="channel">{fc.name}</td>
                  <td data-label="description">{fc.description}</td>
                  <td data-label="position">{fc.position}</td>
                  <td data-label="enabled">{fc.enabled ? "yes" : "no"}</td>
                  <td data-label="actions">
                    <button
                      type="button"
                      class="adm-btn"
                      onClick={() => props.onToggleEnabled(fc)}
                      data-testid={`admin-network-featured-toggle-${props.net.slug}-${fc.id}`}
                    >
                      {fc.enabled ? "Disable" : "Enable"}
                    </button>
                    <InlineConfirmButton
                      idleLabel="Delete"
                      confirmLabel="Confirm delete"
                      armed={props.confirmingFeaturedKey === `${props.net.id}:${fc.id}`}
                      onArm={() => props.onArmFeaturedDelete(`${props.net.id}:${fc.id}`)}
                      onConfirm={() => props.onDeleteFeatured(fc)}
                      testId={`admin-network-featured-delete-${props.net.slug}-${fc.id}`}
                      extraClass="delete-btn"
                    />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </AdminTable>
      </Show>
    </div>
  );
};

export default AdminNetworksTab;
