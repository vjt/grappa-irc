import {
  deleteAccount as apiDeleteAccount,
  updateNetworkIdentity as apiUpdateNetworkIdentity,
} from "./api";
import { clearLocalAuth, getSubject, isPersistentIdentity, logout, token } from "./auth";
import { requestConfirm } from "./confirmDialog";
import { refetchUser } from "./networks";
import { quitAll } from "./quit";

// #126 — the canonical session-lifecycle vocabulary, subject-routed in
// ONE place. "logout" is RETIRED as a user-facing verb: `detach` IS the
// web logout for a persistent identity, and an ephemeral visitor's
// "quit" is what used to be called logout. The verbs map onto the
// (web client × upstream IRC) state matrix:
//
//   web UP   + upstream UP   = normal
//   web UP   + upstream DOWN = per-network park/reconnect (home page)
//   web DOWN + upstream UP   = detach
//   web DOWN + upstream DOWN = quit
//
// #211 phase 6 — per-network disconnect/reconnect is NO LONGER a
// lifecycle verb: BOTH subjects park/reconnect each network via
// `PATCH /networks/:id {connection_state}` on the home page (ruling D).
// The visitor-only `disconnect`/`reconnect` lifecycle verbs (+ their
// `POST /session/{disconnect,reconnect}` server calls) are RETIRED.
// `detach` + `quit` remain. See GH #126.

/**
 * detach — leave cicchetto but KEEP the bouncer (server-side
 * `Session.Server` + upstream IRC connection) UP. Pure web-session
 * revoke: `DELETE /auth/logout` no longer tears the session down for a
 * persistent identity. Offered to a registered user + a NickServ visitor.
 */
export async function detach(): Promise<void> {
  await logout();
}

/**
 * quit — close cicchetto AND tear down the live IRC session. Universal,
 * but the teardown path differs by subject:
 *
 *   * user → park ALL networks then detach (`quitAll`).
 *   * registered visitor → #211 phase 6: ALSO park ALL networks then
 *     detach (`quitAll`). Visitors carry a real per-network
 *     `connection_state` now, so the global disconnect is the SAME
 *     client-composed park-all users use (the `POST /session/disconnect`
 *     verb is retired). The parks persist across reboot (Bootstrap skips
 *     parked visitor credentials); the row + scrollback survive detach
 *     (`purge_if_anon` no-ops a registered visitor).
 *   * ephemeral (anon) visitor → detach only: `DELETE /auth/logout`'s
 *     anon branch stops the session(s) AND purges the row server-side.
 */
export async function quit(): Promise<void> {
  const subject = getSubject();

  // #477 — the teardown path is a question of PERSISTENCE, not subject
  // class: a user AND a registered visitor are BOTH persistent identities
  // and take the SAME nuclear path (park all networks → detach; the parks
  // persist across reboot, the row + scrollback survive). Only an ephemeral
  // (anon) visitor — or the not-yet-loaded null subject — differs. Routing
  // on the shared `isPersistentIdentity` predicate collapses the two
  // hand-rolled class-branches that asked this one question.
  if (isPersistentIdentity(subject)) {
    await quitAll(null);
    return;
  }

  // ephemeral (anon) visitor: detach only — the anon branch of
  // `DELETE /auth/logout` stops every attached session + purges the row.
  await logout();
}

// #986 — the two verbs above are rail-actions entries now, each behind the
// shared #195 confirm modal. The GATE and the COPY live here, beside the
// verbs they describe, exactly as windowClose.ts colocates
// `confirmLeaveChannel` with the PART it fires: a modal that misdescribes
// the consequence is worse than no modal at all, and the only way copy and
// teardown cannot drift is to derive both from the same subject read.
//
// The two-tap `InlineConfirmButton` this replaces asked "really quit IRC?"
// — six words that were the SAME for an anon visitor (whose row the server
// hard-deletes on the way out) and a registered user (whose account and
// scrollback survive untouched). Those are not the same event, so they do
// not get the same sentence.
//
// No typed re-entry gate here, deliberately: that friction belongs to
// `delete account` alone, the one door that destroys a persistent identity
// (#986 ruling). detach and quit explain, then ask.

const DETACH_BODY =
  "Leave cicchetto in this browser. The bouncer keeps running: your networks stay " +
  "connected and your scrollback keeps filling, so it is all still here when you come back.";

const QUIT_BODY_USER =
  "Park every network and take the bouncer offline. Your account, its settings and its " +
  "scrollback survive — log back in whenever you want to reconnect.";

const QUIT_BODY_REGISTERED_VISITOR =
  "Park every network and take the bouncer offline. Your session is registered, so the " +
  "server keeps it: your nick and its scrollback survive — identify again to come back.";

const QUIT_BODY_EPHEMERAL =
  "Leave IRC and end this session. It is not registered, so the server DELETES it on the " +
  "way out — windows, scrollback, settings, all of it, permanently. There is nothing to " +
  "come back to.";

/**
 * canDetach — is `detach` a meaningful verb for the current subject? True
 * for a persistent identity only: an ephemeral visitor has no bouncer to
 * leave running, so "leave cic, keep the session" is not on offer.
 *
 * Routed through the shared `isPersistentIdentity` predicate — the SAME
 * question `quit()` asks one screen up — so the affordance and the teardown
 * path can never answer it differently.
 */
export function canDetach(): boolean {
  return isPersistentIdentity(getSubject());
}

// The three consequences of `quit`, keyed off the subject the way `quit()`
// itself is. A persistent identity survives, so the split inside that arm is
// about the NOUN the operator owns (an account they log back into vs a
// registered session they re-identify to) — not about the teardown, which is
// one `quitAll` for both. The null (not-yet-loaded) subject falls to the
// ephemeral copy because that is the arm `quit()` routes it to.
function quitBody(): string {
  const subject = getSubject();
  if (subject !== null && isPersistentIdentity(subject)) {
    return subject.kind === "user" ? QUIT_BODY_USER : QUIT_BODY_REGISTERED_VISITOR;
  }
  return QUIT_BODY_EPHEMERAL;
}

/**
 * confirmDetach — open the shared confirm modal for `detach`, firing the
 * verb and then `onDone` only on the affirmative. `onDone` is the caller's
 * landing (the rail passes `navigate("/login")`): `logout()` nulls the token
 * and RequireAuth would redirect anyway, but the explicit navigation makes
 * the landing deterministic rather than effect-ordered.
 */
export function confirmDetach(onDone: () => void): void {
  requestConfirm({
    title: "Detach",
    body: DETACH_BODY,
    confirmLabel: "Detach",
    onConfirm: () => void detach().then(onDone),
    alternative: null,
  });
}

/**
 * confirmQuit — open the shared confirm modal for `quit`, with the body that
 * is TRUE for the current subject. Same fire-then-land shape as
 * `confirmDetach`.
 */
export function confirmQuit(onDone: () => void): void {
  requestConfirm({
    title: "Quit IRC",
    body: quitBody(),
    confirmLabel: "Quit IRC",
    onConfirm: () => void quit().then(onDone),
    alternative: null,
  });
}

/**
 * updateIdentity — #211 phase 7 — set a visitor's PER-NETWORK IRC identity
 * (nick + ident + realname) on `networkSlug`, live-applied server-side via
 * internal reconnect (`PATCH /networks/:slug/identity`, the subject-agnostic
 * door that replaced the retired `PATCH /me/identity`). Refetches `/me` so
 * the SettingsDrawer reflects the persisted values.
 *
 * Errors PROPAGATE (unlike quit/logout): a 422 (bad nick/ident) must
 * surface so the drawer can render the inline validation message instead of
 * silently swallowing the change.
 */
export async function updateIdentity(
  networkSlug: string,
  fields: { nick?: string; ident?: string; realname?: string },
): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiUpdateNetworkIdentity(t, networkSlug, fields);
  refetchUser();
}

/**
 * deleteAccount — #157 IRREVERSIBLE total wipe. DISTINCT from quit, NOT
 * routed through it: quit PRESERVES a persistent identity (a registered
 * visitor's row + scrollback survive; a user's account survives a
 * park-all), whereas deleteAccount DESTROYS the account + all associated
 * state server-side, then clears the local bearer. Offered ONLY to a
 * registered non-admin user or a registered visitor — the server 403s
 * everyone else (admin / anon). The cic confirm modal is the
 * irreversibility gate; this verb is the deliberate action it triggers.
 *
 * Errors PROPAGATE (unlike quit/logout, which swallow "user wants out"):
 * a failed wipe (403, server error) must surface so the local token is
 * NOT cleared on a still-existing account. `clearLocalAuth` runs ONLY
 * after the server's 204 — the session row is cascade-gone by then, so
 * there is nothing left to revoke.
 */
export async function deleteAccount(): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiDeleteAccount(t);
  clearLocalAuth();
}
