import { patchNetwork } from "./api";
import { logout, token } from "./auth";
import { networks } from "./networks";

// UX-4 bucket D — extracted from compose.ts /quit handler so the sidebar
// server-window × can call the same nuclear path for visitors (Bucket D
// — visitor: equivalent to /quit). Park every bound user-network, then
// logout.
// The logout drives RequireAuth → /login.
//
// `Promise.allSettled` — partial PATCH failures do NOT block the logout.
// The user wants OUT regardless of individual network PATCH success. One
// failed PATCH means that network may auto-respawn on next boot (only
// `:parked` rows skip Bootstrap respawn), but the session is still
// terminated from cicchetto's perspective.
//
// Visitor networks are FILTERED OUT — the server's
// `require_user_subject` plug 403s any PATCH from a visitor token. The
// loop would always log a rejection for the visitor's own network; the
// logout() call after the loop is what tears down the visitor session
// server-side. Keep the loop quiet by skipping visitor rows up front.
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
  const allNets = (networks() ?? []).filter((n) => n.kind === "user");
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
