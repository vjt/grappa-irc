// #254 — subscribe-before-send indirection seam.
//
// compose.ts must be able to await a query topic's WS join ACK BEFORE the
// first `/msg` PRIVMSG POST fires, so the server's own-echo broadcast has a
// live listener (the echo stays the SOLE render path — no optimistic local
// render). The join machinery lives inside subscribe.ts's module-init
// `createRoot` (the whole WS subscription tree). Importing subscribe.ts from
// compose.ts to reach it would boot that tree inside compose's UNIT tests
// (jsdom, no live socket) → `TypeError: fetch() URL is invalid` at init.
//
// This leaf module is the decoupling boundary: subscribe.ts registers the real
// implementation once its createRoot evaluates at app boot (main.tsx imports
// subscribe for its side effect); compose.ts calls the getter. The default
// no-op resolves immediately — correct for the pre-boot window AND for compose
// unit tests, where the WS join is not under test and the reactive
// query-windows loop (in the real app) still joins the topic on its own.

let impl: (slug: string, target: string) => Promise<void> = () => Promise.resolve();

// Called once from subscribe.ts's createRoot with the real join+await verb.
export function setEnsureQueryTopicJoined(
  fn: (slug: string, target: string) => Promise<void>,
): void {
  impl = fn;
}

// Ensure the (slug,target) query topic is joined + ACKed. Idempotent + bounded
// inside the registered impl (see subscribe.ts); a no-op resolve before the WS
// layer has registered.
export function ensureQueryTopicJoined(slug: string, target: string): Promise<void> {
  return impl(slug, target);
}
