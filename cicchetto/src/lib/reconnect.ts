import { patchNetwork } from "./api";
import { token } from "./auth";
import { networks } from "./networks";

// #282 — explicit "Reconnect to apply" verb behind the vhost sub-page
// footer button.
//
// The vhost (source-bind address) is ACCOUNT-level and resolved fresh PER
// CONNECT (`Grappa.Vhosts.effective_source/2`: the subject's selection,
// intersected with its allowed set, picked at connect time). So a changed
// selection is INERT until the upstream socket is re-established. This verb
// BOUNCES every currently-`connected` network — park then reconnect — so
// each fresh connection re-binds from the (new) selection; the server
// re-JOINs and emits `connection_state_changed`, which `userTopic.ts`
// patches in place.
//
// This reuses the SAME per-network `PATCH /networks/:slug {connection_state}`
// path the home-page Reconnect (`HomePane` `DisconnectedRow`) drives — the
// clean SAME-ACCOUNT teardown. It is deliberately NOT:
//   * the #281 identity-change client purge (`identityScopedStore`
//     `onIdentityChange`) — that's account-SWITCH semantics, keyed on a
//     token rotation a same-account bounce never triggers, and its
//     404-storm risk (stale CROSS-account state) does not apply here; nor
//   * the visitor identity-apply path (`updateIdentity` → PATCH
//     /networks/:slug/identity) — that carries nick/ident/realname, not
//     the vhost selection.
//
// Only `:connected` networks are bounced. A `:parked` / `:failed` network
// was left down deliberately (home-page park, admission failure); it will
// pick up the new vhost whenever the user reconnects it from the home
// page. Bouncing it here would be an unrelated state change.
//
// Each network's park→reconnect is sequential (the park must settle before
// the reconnect), but networks are independent so the whole set runs
// concurrently. `Promise.allSettled` — a failure on one network must not
// abort the others (mirrors `quitAll`); failures are logged per-network,
// then the FIRST is re-thrown so the caller can surface it (the button
// renders `friendlyApiError`). A network whose park PATCH fails is never
// reconnected (the sequential await short-circuits its `bounce`).

async function bounce(t: string, slug: string): Promise<void> {
  await patchNetwork(t, slug, { connection_state: "parked" });
  await patchNetwork(t, slug, { connection_state: "connected" });
}

export async function reconnectConnectedNetworks(): Promise<void> {
  const t = token();
  if (t === null) return;
  const connected = (networks() ?? []).filter((n) => n.connection_state === "connected");
  if (connected.length === 0) return;

  const results = await Promise.allSettled(connected.map((n) => bounce(t, n.slug)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  for (const f of failures) {
    console.warn("[reconnect] bounce failed:", f.reason);
  }
  const first = failures[0];
  if (first !== undefined) throw first.reason;
}
