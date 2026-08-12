import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminField from "./admin/AdminField";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import { connectionTone } from "./admin/connectionTone";
import {
  type AdminCredential,
  type AdminCredentialUpdate,
  type AdminNetwork,
  type AdminUser,
  ApiError,
  adminBindCredential,
  adminListCredentials,
  adminListNetworks,
  adminUnbindCredential,
  adminUpdateCredential,
} from "./lib/api";
import { token } from "./lib/auth";
import { operatorApiError } from "./lib/friendlyApiError";
import { IRCAUTH_FSMAUTH_METHOD } from "./lib/wireTypes";

// #1158 — one user, one page, and it owns that user's network access.
//
// This replaced the Credentials tab, which was a flat list of every
// (user, network) binding in the database fronted by a form whose first
// two fields were "which user" and "which network". vjt's ruling: the
// operator's object is the USER. The user is the page, so nothing here
// asks which user.
//
// Reached from the Users tab, which owns the signal that swaps its list
// for this page. Deliberately NOT a route: the admin console has no
// routing at all, and whether a single user deserves a shareable URL is
// an open product question. Answering it later means adding a route,
// which is additive; guessing it now would mean inventing the console's
// first deep link as a side effect of a credentials cleanup.
//
// #1157 — and the "bind a credential" flow is gone with it. vjt:
// *"niente flusso bind credential; al suo posto una sezione per rete
// configurata con una checkbox `enabled`, e quando e' abilitata compare
// il form di impostazioni di quella rete."*
//
// So the page no longer lists the networks the user HAS beside a `+`
// offering the ones it has not. It lists every network the server has
// configured, once, and the checkbox is the whole statement about
// access. That collapses three surfaces — an add form, an inline edit
// form, and a per-row detail panel — into one form per section, because
// they only ever differed in which subset of the same fields they showed
// and in whether the answer went out as a POST or a PATCH.
//
// The checkbox is NOT a write. Enabling reveals the settings form and
// nothing reaches the server until Save, because a bind needs a nick and
// a checkbox cannot supply one. Disabling a network that IS bound is
// destructive — it deletes the credential and stops the session — so it
// arms rather than fires: the box goes unchecked and the section asks.
// That is the same two-step as the inline-confirm buttons elsewhere in
// the console, spread across the two controls this shape already has.
//
// Data comes from the endpoints that already exist — no composite
// create-user-and-bind POST (vjt: two writes, client-driven).
// `GET /admin/credentials` is unfiltered and its `filters` argument was
// a dead letter (the controller's `index/2` ignores params), so the
// owner filter is applied HERE, in `mine()`. Getting that wrong shows
// another user's networks on this user's page, which is why the unit
// suite mounts with a foreign credential in every fetch.
//
// `session_action` is per-SECTION state, never a toast (vjt: a toast
// throws away four values). It carries all four — `spawned` /
// `not_spawned` from the POST, `left_alone` / `stopped` from the PATCH —
// plus `session_error`, the only field that says why a bind did not dial.
//
// Raw wire tokens on purpose, per the operator-console policy
// (AdminSettingsTab lines 33-35, #943): the operator reads the same
// word the server sent.
//
// `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT — the
// AdminPane mount gate is the reachability boundary.

export type Props = {
  user: AdminUser;
  onBack: () => void;
};

/** The settings a credential carries, as the form holds them. */
type NetworkForm = {
  nick: string;
  realname: string;
  sasl_user: string;
  auth_method: string;
  password: string;
};

const EMPTY_FORM: NetworkForm = {
  nick: "",
  realname: "",
  sasl_user: "",
  auth_method: "none",
  password: "",
};

/** What the last write did to the live session, for one network. */
type SessionOutcome = {
  action: NonNullable<AdminCredential["session_action"]>;
  error: NonNullable<AdminCredential["session_error"]> | null;
};

// The server's truth for a bound network, as a draft. `password` starts
// empty at every seeding: the stored one is write-only (encrypted at
// rest, never returned), so a blank box means "leave it alone" and
// anything typed means "replace it".
function formOf(c: AdminCredential): NetworkForm {
  return {
    nick: c.nick,
    realname: c.realname ?? "",
    sasl_user: c.sasl_user ?? "",
    auth_method: c.auth_method,
    password: "",
  };
}

// Only what the operator changed goes on the wire: the server keys the
// session kill off the CHANGE SET, so sending an unchanged password
// would stop a live session for nothing.
function patchOf(c: AdminCredential, f: NetworkForm): AdminCredentialUpdate {
  const patch: AdminCredentialUpdate = {};
  if (f.nick !== c.nick) patch.nick = f.nick;
  if (f.realname !== (c.realname ?? "")) patch.realname = f.realname;
  if (f.sasl_user !== (c.sasl_user ?? "")) patch.sasl_user = f.sasl_user;
  if (f.auth_method !== c.auth_method) patch.auth_method = f.auth_method;
  if (f.password !== "") patch.password = f.password;
  return patch;
}

const AdminUserPage: Component<Props> = (props) => {
  const [credentials, setCredentials] = createSignal<AdminCredential[] | null>(null);
  const [networks, setNetworks] = createSignal<AdminNetwork[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [submitting, setSubmitting] = createSignal<number | null>(null);

  // The draft per network, seeded lazily from the credential. Absent
  // means "not touched since the last fetch", which is what lets a
  // successful save fall back to the server's own answer by simply
  // dropping the entry.
  const [forms, setForms] = createSignal<Record<number, NetworkForm>>({});
  // Enabled by the operator, not yet written — a bind needs a nick.
  const [pendingEnable, setPendingEnable] = createSignal<Record<number, boolean>>({});
  // The one network whose removal is armed. Single, like every other
  // confirm in the console: two armed destructive verbs on one screen is
  // how the wrong one gets pressed.
  const [pendingDisable, setPendingDisable] = createSignal<number | null>(null);

  // Keyed by network id, which is the section. A write reports on the
  // section it touched and says nothing about any other.
  const [outcomes, setOutcomes] = createSignal<Record<number, SessionOutcome>>({});

  /** This user's networks. The list endpoint returns everyone's. */
  const mine = createMemo<AdminCredential[]>(() =>
    (credentials() ?? []).filter((c) => c.user_id === props.user.id),
  );

  const credOf = (networkId: number): AdminCredential | undefined =>
    mine().find((c) => c.network_id === networkId);

  const formFor = (networkId: number): NetworkForm => {
    const draft = forms()[networkId];
    if (draft !== undefined) return draft;
    const c = credOf(networkId);
    return c === undefined ? { ...EMPTY_FORM } : formOf(c);
  };

  const setForm = (networkId: number, patch: Partial<NetworkForm>): void => {
    setForms({ ...forms(), [networkId]: { ...formFor(networkId), ...patch } });
  };

  const clearForm = (networkId: number): void => {
    const { [networkId]: _gone, ...rest } = forms();
    setForms(rest);
  };

  /** The section shows its settings form. */
  const enabled = (networkId: number): boolean => {
    if (pendingDisable() === networkId) return false;
    return credOf(networkId) !== undefined || pendingEnable()[networkId] === true;
  };

  /** What Save would send to a BOUND network; `null` when unbound. */
  const pending = (networkId: number): AdminCredentialUpdate | null => {
    const c = credOf(networkId);
    if (c === undefined) return null;
    return patchOf(c, formFor(networkId));
  };

  const savable = (networkId: number): boolean => {
    if (submitting() !== null) return false;
    if (formFor(networkId).nick.trim() === "") return false;
    const patch = pending(networkId);
    // Unbound: Save IS the bind, and a nick is all it needs. Bound: only
    // when something actually changed, because an empty PATCH would ask
    // the server to decide whether to stop a session over nothing.
    return patch === null || Object.keys(patch).length > 0;
  };

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    try {
      const [creds, nets] = await Promise.all([adminListCredentials(t), adminListNetworks(t)]);
      setCredentials(creds);
      setNetworks(nets);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "fetch_failed");
    } finally {
      setLoading(false);
    }
  };

  const recordOutcome = (networkId: number, cred: AdminCredential): void => {
    const action = cred.session_action;
    if (action === undefined) return;
    setOutcomes({
      ...outcomes(),
      [networkId]: { action, error: cred.session_error ?? null },
    });
  };

  const onToggle = (net: AdminNetwork): void => {
    const id = net.id;
    if (pendingDisable() === id) {
      // Re-ticking a network whose removal was armed is the cancel.
      setPendingDisable(null);
      return;
    }
    if (credOf(id) !== undefined) {
      setPendingDisable(id);
      return;
    }
    if (pendingEnable()[id] === true) {
      const { [id]: _gone, ...rest } = pendingEnable();
      setPendingEnable(rest);
      clearForm(id);
      return;
    }
    setPendingEnable({ ...pendingEnable(), [id]: true });
  };

  const onSave = async (net: AdminNetwork, e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const id = net.id;
    const f = formFor(id);
    const existing = credOf(id);
    setSubmitting(id);
    setError(null);
    try {
      const saved =
        existing === undefined
          ? await adminBindCredential(t, {
              user_id: props.user.id,
              network_id: id,
              nick: f.nick,
              auth_method: f.auth_method,
              password: f.password === "" ? undefined : f.password,
              sasl_user: f.sasl_user === "" ? undefined : f.sasl_user,
              realname: f.realname === "" ? undefined : f.realname,
            })
          : await adminUpdateCredential(t, props.user.id, id, patchOf(existing, f));
      recordOutcome(id, saved);
      // Drop the draft rather than rewriting it: the section then reads
      // the server's own answer, and the typed password leaves with it.
      clearForm(id);
      const { [id]: _gone, ...rest } = pendingEnable();
      setPendingEnable(rest);
      await refresh();
    } catch (err) {
      setError(`${net.slug}: ${operatorApiError(err, "request_failed")}`);
    } finally {
      setSubmitting(null);
    }
  };

  const onRemove = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    const id = net.id;
    setError(null);
    try {
      await adminUnbindCredential(t, props.user.id, id);
      const cur = credentials();
      if (cur !== null) {
        setCredentials(cur.filter((x) => !(x.user_id === props.user.id && x.network_id === id)));
      }
      // The credential is gone; a verdict about its session would
      // outlive it, and so would a draft of its settings.
      const { [id]: _goneOutcome, ...restOutcomes } = outcomes();
      setOutcomes(restOutcomes);
      clearForm(id);
      setPendingDisable(null);
    } catch (err) {
      setError(`remove ${net.slug}: ${operatorApiError(err, "request_failed")}`);
      setPendingDisable(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-user-page" data-testid="admin-user-page">
      <div class="adm-scroll">
        <header class="adm-subpage-head">
          <button
            type="button"
            class="adm-btn"
            onClick={props.onBack}
            aria-label="back to the users list"
            data-testid="admin-user-page-back"
          >
            ← Users
          </button>
          <h2 class="adm-card-title" data-testid="admin-user-page-name">
            {props.user.name}
          </h2>
          <Show when={props.user.is_admin}>
            <AdminBadge tone="ok">admin</AdminBadge>
          </Show>
        </header>

        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-user-page-error" />
        </Show>

        <Show when={credentials() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={credentials() !== null}>
          <AdminCard
            title="Networks"
            subtitle="one section per configured network — tick to give this user access; CONNECTION is the DB state, LIVE is the BEAM pid, and they can disagree"
            data-testid="admin-user-networks-card"
            actions={
              <button
                type="button"
                class="adm-btn"
                disabled={loading()}
                onClick={() => {
                  void refresh();
                }}
                aria-label="refresh this user's networks"
                data-testid="admin-user-networks-refresh"
              >
                Refresh
              </button>
            }
          >
            <Show
              when={networks().length > 0}
              fallback={
                // Not "this user is on no networks": with one section per
                // configured network, an empty page means the SERVER has
                // none — a different thing, fixed somewhere else.
                <AdminEmpty
                  message="no networks are configured on this server"
                  testId="admin-user-networks-empty"
                />
              }
            >
              <For each={networks()}>
                {(net) => (
                  <section
                    class="adm-subsection admin-user-network"
                    data-testid={`admin-user-network-${net.id}`}
                  >
                    <div class="admin-user-network-head">
                      <label class="adm-check">
                        <input
                          type="checkbox"
                          checked={enabled(net.id)}
                          onChange={() => onToggle(net)}
                          aria-label={`${props.user.name} may use ${net.slug}`}
                          data-testid={`admin-user-network-enabled-${net.id}`}
                        />
                        <span class="adm-subsection-title">{net.slug}</span>
                      </label>
                      {/* Both projections, always, for a bound network —
                          `live: BEAM has no pid` against `connection:
                          connected` IS the divergence signal, and deriving
                          either from the other would erase it. */}
                      <Show when={credOf(net.id)}>
                        {(c) => (
                          <span class="admin-user-network-state">
                            <AdminBadge
                              tone={connectionTone(c().connection_state)}
                              testId={`admin-user-network-connection-${net.id}`}
                            >
                              {c().connection_state}
                            </AdminBadge>
                            <AdminBadge
                              tone={
                                c().live_state === null
                                  ? "neutral"
                                  : c().live_state?.alive === true
                                    ? "ok"
                                    : "danger"
                              }
                              testId={`admin-user-network-live-${net.id}`}
                            >
                              {c().live_state === null
                                ? "BEAM has no pid"
                                : c().live_state?.alive === true
                                  ? "alive"
                                  : "pid dead"}
                            </AdminBadge>
                          </span>
                        )}
                      </Show>
                    </div>

                    <Show when={outcomes()[net.id]}>
                      {(outcome) => (
                        <p
                          class="adm-card-sub"
                          data-testid={`admin-user-network-session-action-${net.id}`}
                        >
                          session: {outcome().action}
                          <Show when={outcome().error !== null}> ({outcome().error})</Show>
                        </p>
                      )}
                    </Show>

                    {/* The second half of the two-step. Unticking a bound
                        network is the arm; this is the fire, and it names
                        what it destroys rather than repeating the word on
                        the box. */}
                    <Show when={pendingDisable() === net.id}>
                      <div class="adm-danger-strip">
                        <span class="adm-danger-note">
                          removes this user's credential for {net.slug} and stops its session
                        </span>
                        <button
                          type="button"
                          class="adm-btn adm-btn--danger"
                          onClick={() => {
                            void onRemove(net);
                          }}
                          data-testid={`admin-user-network-remove-${net.id}`}
                        >
                          Remove access
                        </button>
                        <button
                          type="button"
                          class="adm-btn"
                          onClick={() => setPendingDisable(null)}
                          data-testid={`admin-user-network-keep-${net.id}`}
                        >
                          Cancel
                        </button>
                      </div>
                    </Show>

                    <Show when={enabled(net.id)}>
                      <form
                        onSubmit={(e) => {
                          void onSave(net, e);
                        }}
                        data-testid={`admin-user-network-form-${net.id}`}
                      >
                        {/* #1157 — vjt: "una form piu' umana: fieldset, un
                            campo per riga". A real `<fieldset>`, so the
                            group has a name a screen reader reads once
                            instead of five placeholder-only boxes, and
                            `.adm-field-rows` (Settings' idiom) to put each
                            label beside its own control. */}
                        <fieldset class="adm-fieldset">
                          <legend class="adm-fieldset-legend">{net.slug} settings</legend>
                          <div class="adm-field-rows">
                            <AdminField label="nick" for={`admin-user-network-nick-${net.id}`}>
                              <input
                                id={`admin-user-network-nick-${net.id}`}
                                type="text"
                                value={formFor(net.id).nick}
                                onInput={(e) =>
                                  setForm(net.id, {
                                    nick: (e.currentTarget as HTMLInputElement).value,
                                  })
                                }
                                data-testid={`admin-user-network-nick-${net.id}`}
                                required
                              />
                            </AdminField>
                            <AdminField
                              label="realname"
                              for={`admin-user-network-realname-${net.id}`}
                            >
                              <input
                                id={`admin-user-network-realname-${net.id}`}
                                type="text"
                                value={formFor(net.id).realname}
                                onInput={(e) =>
                                  setForm(net.id, {
                                    realname: (e.currentTarget as HTMLInputElement).value,
                                  })
                                }
                                data-testid={`admin-user-network-realname-${net.id}`}
                              />
                            </AdminField>
                            <AdminField
                              label="sasl user"
                              for={`admin-user-network-sasl-user-${net.id}`}
                            >
                              <input
                                id={`admin-user-network-sasl-user-${net.id}`}
                                type="text"
                                value={formFor(net.id).sasl_user}
                                onInput={(e) =>
                                  setForm(net.id, {
                                    sasl_user: (e.currentTarget as HTMLInputElement).value,
                                  })
                                }
                                data-testid={`admin-user-network-sasl-user-${net.id}`}
                              />
                            </AdminField>
                            <AdminField
                              label="auth method"
                              for={`admin-user-network-auth-method-${net.id}`}
                            >
                              <select
                                id={`admin-user-network-auth-method-${net.id}`}
                                value={formFor(net.id).auth_method}
                                onChange={(e) =>
                                  setForm(net.id, {
                                    auth_method: (e.currentTarget as HTMLSelectElement).value,
                                  })
                                }
                                data-testid={`admin-user-network-auth-method-${net.id}`}
                              >
                                <For each={IRCAUTH_FSMAUTH_METHOD}>
                                  {(m) => <option value={m}>{m}</option>}
                                </For>
                              </select>
                            </AdminField>
                            <AdminField
                              label="password"
                              for={`admin-user-network-password-${net.id}`}
                              hint={
                                credOf(net.id) === undefined
                                  ? undefined
                                  : "blank leaves the stored one alone"
                              }
                            >
                              <input
                                id={`admin-user-network-password-${net.id}`}
                                type="password"
                                value={formFor(net.id).password}
                                onInput={(e) =>
                                  setForm(net.id, {
                                    password: (e.currentTarget as HTMLInputElement).value,
                                  })
                                }
                                data-testid={`admin-user-network-password-${net.id}`}
                              />
                            </AdminField>
                          </div>
                        </fieldset>
                        <div class="adm-form-grid-actions">
                          <button
                            type="submit"
                            class="adm-btn adm-btn--ok"
                            disabled={!savable(net.id)}
                            data-testid={`admin-user-network-save-${net.id}`}
                          >
                            Save
                          </button>
                        </div>
                      </form>
                    </Show>
                  </section>
                )}
              </For>
            </Show>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

export default AdminUserPage;
