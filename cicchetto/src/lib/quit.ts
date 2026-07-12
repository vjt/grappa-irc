import { patchNetwork } from "./api";
import { logout, token } from "./auth";
import { networks } from "./networks";

// UX-4 bucket D — extracted from compose.ts /quit handler so the sidebar
// server-window × can call the same nuclear path. Park every bound
// network, then logout. The logout drives RequireAuth → /login.
//
// `Promise.allSettled` — partial PATCH failures do NOT block the logout.
// The user wants OUT regardless of individual network PATCH success. One
// failed PATCH means that network may auto-respawn on next boot (only
// `:parked` rows skip Bootstrap respawn), but the session is still
// terminated from cicchetto's perspective.
//
// #211 phase 6 — BOTH subjects park now. Visitors carry a real
// per-network `connection_state` (ruling D) and `PATCH /networks/:id`
// is subject-agnostic, so a visitor's global disconnect IS the same
// client-composed park-all a user's is (the pre-phase-6
// `require_user_subject` 403 that forced the `kind === "user"` filter is
// gone). For a REGISTERED visitor the parks persist across reboot
// (Bootstrap skips parked visitor credentials); for an anon visitor the
// subsequent logout's anon-branch stops + purges regardless.
//
// Codebase audit cic M5 — surface partial failures via console.warn so a
// silent ghost-state never hides during the navigate-away window.
//
// Returns a Promise that resolves AFTER logout — caller can `void` it if
// they don't care about completion (the component tree unmounts on
// setToken(null) anyway).
export async function quitAll(reason: string | null): Promise<void> {
  const t = token();
  if (t === null) return;
  const allNets = networks() ?? [];
  const parkBody: { connection_state: "parked"; reason?: string } = {
    connection_state: "parked",
  };
  if (reason !== null) parkBody.reason = reason;
  const results = await Promise.allSettled(allNets.map((n) => patchNetwork(t, n.slug, parkBody)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const net = allNets[i];
    if (r === undefined || net === undefined) continue;
    if (r.status === "rejected") {
      console.warn(`[/quit] PATCH park failed for network ${net.slug}:`, r.reason);
    }
  }
  await logout();
}
