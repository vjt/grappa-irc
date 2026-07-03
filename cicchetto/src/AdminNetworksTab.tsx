import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
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
//   * Force Reap (InlineConfirmButton) — POST /admin/reaper/run.
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
// 12s)" / "—" / "Force Reap" / etc).
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
    Record<number, { host: string; port: string; tls: boolean }>
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
          draft[net.id] = { host: "", port: "6697", tls: true };
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
    try {
      await adminAddServer(t, net.id, { host: f.host.trim(), port, tls: f.tls });
      setServerForm(
        produce((draft) => {
          draft[net.id] = { host: "", port: "6697", tls: true };
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
      <header class="admin-networks-header">
        <InlineConfirmButton
          idleLabel="Force Reap"
          confirmLabel="Confirm reap?"
          armed={confirmingKey() === reapKey()}
          onArm={() => setConfirmingKey(reapKey())}
          onConfirm={onForceReap}
          testId="admin-networks-force-reap"
          extraClass="force-reap-btn"
        />
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh networks list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-networks-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <Show when={reapResult() !== null}>
        <p class="admin-success" data-testid="admin-networks-reap-result">
          reaper swept {reapResult()?.count} visitor(s)
        </p>
      </Show>

      <form
        class="admin-networks-create-form"
        onSubmit={(e) => {
          void onCreateNetwork(e);
        }}
        data-testid="admin-networks-create-form"
      >
        <input
          type="text"
          placeholder="new network slug (e.g. azzurra)"
          value={createSlug()}
          onInput={(e) => setCreateSlug((e.currentTarget as HTMLInputElement).value)}
          data-testid="admin-networks-create-slug"
          aria-label="new network slug"
          required
        />
        <button
          type="submit"
          disabled={creating() || createSlug().trim() === ""}
          data-testid="admin-networks-create-submit"
        >
          Create network
        </button>
      </form>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-networks-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={networks() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={networks() !== null && (networks() ?? []).length === 0}>
        <p class="muted" data-testid="admin-networks-empty">
          no networks
        </p>
      </Show>

      <Show when={networks() !== null && (networks() ?? []).length > 0}>
        <table class="admin-networks-table" data-testid="admin-networks-table">
          <thead>
            <tr>
              <th>slug</th>
              <th>visitors (live/cap)</th>
              <th>max visitor sessions</th>
              <th>users (live/cap)</th>
              <th>max user sessions</th>
              <th>max per ip</th>
              <th>circuit</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={networks() ?? []}>
              {(net) => (
                <>
                  <tr class="admin-networks-row" data-testid={`admin-network-row-${net.slug}`}>
                    <td>
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
                    <td
                      data-testid={`admin-network-live-visitors-${net.slug}`}
                      title={`${effectiveLive(net).visitors} live visitor sessions of ${renderCap(
                        net.max_concurrent_visitor_sessions,
                      )} cap`}
                    >
                      {effectiveLive(net).visitors}/{renderCap(net.max_concurrent_visitor_sessions)}
                    </td>
                    <td>
                      <CapInput
                        slug={net.slug}
                        field="max_concurrent_visitor_sessions"
                        value={edits[net.slug]?.max_concurrent_visitor_sessions ?? ""}
                        onInput={(v) => onEditCap(net.slug, "max_concurrent_visitor_sessions", v)}
                      />
                    </td>
                    <td
                      data-testid={`admin-network-live-users-${net.slug}`}
                      title={`${effectiveLive(net).users} live user sessions of ${renderCap(
                        net.max_concurrent_user_sessions,
                      )} cap`}
                    >
                      {effectiveLive(net).users}/{renderCap(net.max_concurrent_user_sessions)}
                    </td>
                    <td>
                      <CapInput
                        slug={net.slug}
                        field="max_concurrent_user_sessions"
                        value={edits[net.slug]?.max_concurrent_user_sessions ?? ""}
                        onInput={(v) => onEditCap(net.slug, "max_concurrent_user_sessions", v)}
                      />
                    </td>
                    <td>
                      <CapInput
                        slug={net.slug}
                        field="max_per_ip"
                        value={edits[net.slug]?.max_per_ip ?? ""}
                        onInput={(v) => onEditCap(net.slug, "max_per_ip", v)}
                      />
                    </td>
                    <td>
                      <CircuitBadge net={net} />
                    </td>
                    <td class="admin-networks-actions">
                      <button
                        type="button"
                        class="admin-network-save-btn"
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
                          confirmLabel="Confirm reset?"
                          armed={confirmingKey() === resetKey(net.slug)}
                          onArm={() => setConfirmingKey(resetKey(net.slug))}
                          onConfirm={() => onResetCircuit(net)}
                          testId={`admin-network-reset-circuit-${net.slug}`}
                          extraClass="reset-circuit-btn"
                        />
                      </Show>
                      <InlineConfirmButton
                        idleLabel="Delete"
                        confirmLabel="Confirm delete?"
                        armed={confirmingKey() === `delete:${net.slug}`}
                        onArm={() => setConfirmingKey(`delete:${net.slug}`)}
                        onConfirm={() => onDeleteNetwork(net)}
                        testId={`admin-network-delete-${net.slug}`}
                        extraClass="delete-btn"
                      />
                    </td>
                  </tr>
                  <Show when={expandedNetworkId() === net.id}>
                    <tr
                      class="admin-networks-servers-row"
                      data-testid={`admin-network-servers-${net.slug}`}
                    >
                      <td colspan="8">
                        <ServersDisclosure
                          net={net}
                          servers={serversByNetworkId[net.id] ?? []}
                          form={serverForm[net.id] ?? { host: "", port: "6697", tls: true }}
                          onFormChange={(patch) =>
                            setServerForm(
                              produce((draft) => {
                                const cur = draft[net.id] ?? {
                                  host: "",
                                  port: "6697",
                                  tls: true,
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
                      </td>
                    </tr>
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>
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
      class="cap-editor-input"
      classList={{ invalid: invalid() }}
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

const CircuitBadge: Component<{ net: AdminNetwork }> = (props) => {
  if (props.net.circuit_state === null) {
    return (
      <span class="circuit-badge none" data-testid={`admin-network-circuit-${props.net.slug}`}>
        —
      </span>
    );
  }
  const c = props.net.circuit_state;
  return (
    <span
      class={`circuit-badge ${c.state}`}
      data-testid={`admin-network-circuit-${props.net.slug}`}
      title={`failures=${c.failure_count}`}
    >
      {renderCircuitLabel(c.state, c.retry_after_seconds)}
    </span>
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
  form: { host: string; port: string; tls: boolean };
  onFormChange: (patch: Partial<{ host: string; port: string; tls: boolean }>) => void;
  onAddServer: (e: Event) => void;
  onToggleTls: (s: AdminServer) => void;
  confirmingServerKey: string | null;
  onArmServerDelete: (key: string | null) => void;
  onDeleteServer: (s: AdminServer) => void;
}> = (props) => {
  return (
    <div class="admin-network-servers-disclosure">
      <form
        class="admin-network-server-add-form"
        onSubmit={props.onAddServer}
        data-testid={`admin-network-add-server-form-${props.net.slug}`}
      >
        <input
          type="text"
          placeholder="host"
          value={props.form.host}
          onInput={(e) => props.onFormChange({ host: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-server-host-${props.net.slug}`}
          aria-label={`new server host for ${props.net.slug}`}
          required
        />
        <input
          type="number"
          placeholder="port"
          min="1"
          max="65535"
          value={props.form.port}
          onInput={(e) => props.onFormChange({ port: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-server-port-${props.net.slug}`}
          aria-label={`new server port for ${props.net.slug}`}
          required
        />
        <label>
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
        <button
          type="submit"
          disabled={props.form.host.trim() === ""}
          data-testid={`admin-network-add-server-submit-${props.net.slug}`}
        >
          Add server
        </button>
      </form>
      <Show when={props.servers.length === 0}>
        <p class="muted" data-testid={`admin-network-servers-empty-${props.net.slug}`}>
          no servers
        </p>
      </Show>
      <Show when={props.servers.length > 0}>
        <table
          class="admin-network-servers-table"
          data-testid={`admin-network-servers-table-${props.net.slug}`}
        >
          <thead>
            <tr>
              <th>host</th>
              <th>port</th>
              <th>tls</th>
              <th>priority</th>
              <th>enabled</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.servers}>
              {(s) => (
                <tr data-testid={`admin-network-server-row-${props.net.slug}-${s.id}`}>
                  <td>{s.host}</td>
                  <td>{s.port}</td>
                  <td>{s.tls ? "yes" : "no"}</td>
                  <td>{s.priority}</td>
                  <td>{s.enabled ? "yes" : "no"}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => props.onToggleTls(s)}
                      data-testid={`admin-network-server-toggle-tls-${props.net.slug}-${s.id}`}
                    >
                      {s.tls ? "Disable TLS" : "Enable TLS"}
                    </button>
                    <InlineConfirmButton
                      idleLabel="Delete"
                      confirmLabel="Confirm delete?"
                      armed={props.confirmingServerKey === `${props.net.id}:${s.id}`}
                      onArm={() => props.onArmServerDelete(`${props.net.id}:${s.id}`)}
                      onConfirm={() => props.onDeleteServer(s)}
                      testId={`admin-network-server-delete-${props.net.slug}-${s.id}`}
                      extraClass="delete-btn"
                    />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
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
    <div class="admin-network-featured-disclosure">
      <h4 class="admin-network-featured-title">Featured channels</h4>
      <form
        class="admin-network-featured-add-form"
        onSubmit={props.onAddFeatured}
        data-testid={`admin-network-add-featured-form-${props.net.slug}`}
      >
        <input
          type="text"
          placeholder="#channel"
          value={props.form.name}
          onInput={(e) => props.onFormChange({ name: (e.currentTarget as HTMLInputElement).value })}
          data-testid={`admin-network-add-featured-name-${props.net.slug}`}
          aria-label={`new featured channel for ${props.net.slug}`}
          required
        />
        <input
          type="text"
          placeholder="description (optional)"
          value={props.form.description}
          onInput={(e) =>
            props.onFormChange({ description: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-network-add-featured-description-${props.net.slug}`}
          aria-label={`featured description for ${props.net.slug}`}
        />
        <input
          type="number"
          placeholder="position"
          min="0"
          value={props.form.position}
          onInput={(e) =>
            props.onFormChange({ position: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-network-add-featured-position-${props.net.slug}`}
          aria-label={`featured position for ${props.net.slug}`}
        />
        <button
          type="submit"
          disabled={props.form.name.trim() === ""}
          data-testid={`admin-network-add-featured-submit-${props.net.slug}`}
        >
          Add featured
        </button>
      </form>
      <Show when={props.featured.length === 0}>
        <p class="muted" data-testid={`admin-network-featured-empty-${props.net.slug}`}>
          no featured channels
        </p>
      </Show>
      <Show when={props.featured.length > 0}>
        <table
          class="admin-network-featured-table"
          data-testid={`admin-network-featured-table-${props.net.slug}`}
        >
          <thead>
            <tr>
              <th>channel</th>
              <th>description</th>
              <th>position</th>
              <th>enabled</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.featured}>
              {(fc) => (
                <tr data-testid={`admin-network-featured-row-${props.net.slug}-${fc.id}`}>
                  <td>{fc.name}</td>
                  <td>{fc.description}</td>
                  <td>{fc.position}</td>
                  <td>{fc.enabled ? "yes" : "no"}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => props.onToggleEnabled(fc)}
                      data-testid={`admin-network-featured-toggle-${props.net.slug}-${fc.id}`}
                    >
                      {fc.enabled ? "Disable" : "Enable"}
                    </button>
                    <InlineConfirmButton
                      idleLabel="Delete"
                      confirmLabel="Confirm delete?"
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
        </table>
      </Show>
    </div>
  );
};

export default AdminNetworksTab;
