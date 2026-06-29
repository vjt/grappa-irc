import { disconnectSession, reconnectSession } from "./api";
import { getSubject, logout, token } from "./auth";
import { refetchUser } from "./networks";
import { quitAll } from "./quit";

// #126 — the canonical session-lifecycle vocabulary, subject-routed in
// ONE place. "logout" is RETIRED as a user-facing verb: `detach` IS the
// web logout for a persistent identity, and an ephemeral visitor's
// "quit" is what used to be called logout. The four verbs map onto the
// (web client × upstream IRC) state matrix:
//
//   web UP   + upstream UP   = normal
//   web UP   + upstream DOWN = disconnect ⇄ reconnect
//   web DOWN + upstream UP   = detach
//   web DOWN + upstream DOWN = quit
//
// detach + disconnect/reconnect are persistent-identity-only (user +
// registered/NickServ visitor); quit is universal. See GH #126.

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
 *   * user → park ALL networks then detach (`quitAll`, the existing
 *     park-all + logout composite; also driven by the `/quit` compose
 *     verb + the sidebar server-window ×).
 *   * registered visitor → drop the upstream (`POST /session/disconnect`)
 *     then detach. The row + scrollback PERSIST (privacy promise) — the
 *     server's `purge_if_anon` no-ops a registered visitor.
 *   * ephemeral visitor → detach only: `DELETE /auth/logout`'s anon
 *     branch stops the session AND purges the row server-side (exactly
 *     what "logout" did before #126).
 */
export async function quit(): Promise<void> {
  const subject = getSubject();

  if (subject?.kind === "user") {
    await quitAll(null);
    return;
  }

  if (subject?.kind === "visitor" && subject.registered === true) {
    const t = token();
    if (t !== null) {
      // Best-effort: the user wants OUT regardless. A failed upstream
      // drop just leaves the bouncer up; the detach below still revokes
      // the web session.
      try {
        await disconnectSession(t);
      } catch {
        // intentional — see above.
      }
    }
  }

  // ephemeral visitor (and the registered visitor after the drop above):
  // detach revokes the web session; for an anon row it also stops +
  // purges server-side.
  await logout();
}

/**
 * disconnect — drop the upstream IRC connection but KEEP the cicchetto/web
 * session open. Registered (NickServ) visitor only (cic-gated; a user
 * disconnects per-network via the `/disconnect <slug>` compose verb).
 * Refetches `/me` so the whereis-derived `connected` flag flips the
 * SettingsDrawer to its reconnect face (visitors have no
 * `connection_state_changed` broadcast).
 */
export async function disconnect(): Promise<void> {
  const t = token();
  if (t === null) return;
  await disconnectSession(t);
  refetchUser();
}

/**
 * reconnect — restore the upstream IRC connection dropped by `disconnect`.
 * Registered visitor only. Refetches `/me` (connected → true).
 */
export async function reconnect(): Promise<void> {
  const t = token();
  if (t === null) return;
  await reconnectSession(t);
  refetchUser();
}
