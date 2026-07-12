import {
  deleteAccount as apiDeleteAccount,
  updateIdentity as apiUpdateIdentity,
} from "./api";
import { clearLocalAuth, getSubject, logout, token } from "./auth";
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

  if (subject?.kind === "user") {
    await quitAll(null);
    return;
  }

  if (subject?.kind === "visitor" && subject.registered === true) {
    // Registered visitor: park-all persists across reboot, then detach
    // (which preserves the identity). Same nuclear path as a user's quit.
    await quitAll(null);
    return;
  }

  // ephemeral (anon) visitor: detach only — the anon branch of
  // `DELETE /auth/logout` stops every attached session + purges the row.
  await logout();
}

/**
 * updateIdentity — #152 set the visitor's IRC ident + realname,
 * live-applied via internal reconnect. Registered/anon visitor only
 * (the server 403s users). Refetches `/me` so the SettingsDrawer
 * reflects the persisted values.
 *
 * Errors PROPAGATE (unlike quit/logout): a 422 (bad ident) must surface
 * so the drawer can render the inline validation message instead of
 * silently swallowing the change.
 */
export async function updateIdentity(fields: { ident?: string; realname?: string }): Promise<void> {
  const t = token();
  if (t === null) return;
  await apiUpdateIdentity(t, fields);
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
