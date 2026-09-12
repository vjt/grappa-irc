import {
  deleteAccount as apiDeleteAccount,
  deleteNetworkAvatar as apiDeleteNetworkAvatar,
  putNetworkPassword as apiPutNetworkPassword,
  updateNetworkIdentity as apiUpdateNetworkIdentity,
  updateNetworkProfile as apiUpdateNetworkProfile,
  uploadNetworkAvatar as apiUploadNetworkAvatar,
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
 *
 * #1705 — the modal READS "Switch account". The verb stays `detach` in code;
 * only the words the operator sees moved from the bouncer axis to the intent
 * axis. `logout` was not available for this: #126 retired it precisely
 * because it does not say whether the bouncer stays up, and for an ephemeral
 * visitor the thing that used to be called logout is what `quit` is now.
 * "Switch account" names the intent and claims nothing about the connection,
 * so it cannot re-open that ambiguity — and the body below still spells the
 * bouncer half out before the tap.
 */
export function confirmDetach(onDone: () => void): void {
  requestConfirm({
    title: "Switch account",
    body: DETACH_BODY,
    confirmLabel: "Switch account",
    onConfirm: () => void detach().then(onDone),
    alternative: null,
    attachments: null,
    choice: null,
    defaultButton: "cancel",
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
    attachments: null,
    choice: null,
    defaultButton: "cancel",
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
 * updateProfile — the KVIrc-style CTCP USERINFO profile (age/gender/
 * location/languages/a free custom field) on `networkSlug`
 * (`PATCH /networks/:slug/profile`). Unlike identity, there is NO live
 * reconnect: these fields never ride the IRC handshake, they only feed
 * `Grappa.Session.EventRouter`'s CTCP USERINFO auto-reply — the server
 * updates any live session's in-memory copy without bouncing it.
 *
 * Refetches `/me` so the drawer reflects the persisted values. Errors
 * PROPAGATE (unlike quit/logout) — a 422 (CRLF injection, over the byte
 * cap, an unrecognised gender) must surface inline.
 */
export async function updateProfile(
  networkSlug: string,
  fields: { age?: string; gender?: string; location?: string; languages?: string; custom?: string },
): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiUpdateNetworkProfile(t, networkSlug, fields);
  refetchUser();
}

/**
 * uploadAvatar — M3a — sets (or replaces) the own avatar on `networkSlug`
 * (`PUT /networks/:slug/avatar`). Same never-bounces-the-connection
 * posture as `updateProfile` above.
 */
export async function uploadAvatar(networkSlug: string, file: File): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiUploadNetworkAvatar(t, networkSlug, file);
  refetchUser();
}

/**
 * deleteAvatar — M3a — clears the avatar on `networkSlug`
 * (`DELETE /networks/:slug/avatar`).
 */
export async function deleteAvatar(networkSlug: string): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiDeleteNetworkAvatar(t, networkSlug);
  refetchUser();
}

/**
 * updateNetworkPassword — #124 — set the PER-NETWORK password on
 * `networkSlug` (`PUT /networks/:slug/password`), live-applied server-side by
 * the same internal reconnect the identity door uses: the secret is read at
 * connect, so a live session has to re-register to identify with it.
 *
 * The cure for the split brain. One field, one stored secret — this writes the
 * credential password, and that same value is what `$nickserv_pass` expands
 * to. Never send a blank: leave-blank-to-keep lives in the CALLER, so an empty
 * input simply does not reach this (the server 400s a blank rather than
 * treating it as "clear my password").
 *
 * Refetches `/me` so `password_set` reflects the write. Errors PROPAGATE — a
 * 422 (a value Azzurra's services would refuse) must surface inline, because
 * silently storing it is exactly the failure #124 exists to end.
 */
export async function updateNetworkPassword(networkSlug: string, password: string): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiPutNetworkPassword(t, networkSlug, password);
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

// #462 — the sentence under the drawer's `delete account` button, colocated
// with the verb for the reason #986 gave one screen up: copy that lives away
// from the teardown it describes drifts from it, and a door that misdescribes
// what it destroys is worse than an unlabelled one.
//
// Per SUBJECT, not per button: `showDeleteAccount()` offers this to two
// different owners of two different nouns. A user owns an ACCOUNT (a name and
// a password they log back in with); a registered visitor owns a NICK the
// server keeps for them. One sentence covering both would be false for one of
// them. The distinction mirrors QUIT_BODY_USER vs QUIT_BODY_REGISTERED_VISITOR
// exactly, and for the same reason.
//
// What both must say is the thing quit's copy is careful NOT to: this one does
// not survive.

const DELETE_BODY_USER =
  "Erase your account and everything on it — networks, settings, scrollback — from the " +
  "server, permanently. This is not quit: nothing is left to log back into.";

const DELETE_BODY_REGISTERED_VISITOR =
  "Erase your registered nick and everything on it — networks, settings, scrollback — from " +
  "the server, permanently. This is not quit: there is nothing left to identify back to.";

/**
 * deleteAccountBody — the consequence of `delete account` for the current
 * subject, in one sentence. Keyed off the same subject read `quitBody()`
 * uses. The admin and anon cases have no string: they are never offered the
 * affordance (the server 403s them), so the caller renders neither button nor
 * body and the visitor copy is the honest default for the remaining arm.
 */
export function deleteAccountBody(): string {
  return getSubject()?.kind === "user" ? DELETE_BODY_USER : DELETE_BODY_REGISTERED_VISITOR;
}
