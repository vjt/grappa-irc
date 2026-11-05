// Loads `url` as a new document: how a module with no router of its own
// reaches another route (the pairing banner opening `/pair`, issue 2537).
//
// One line, kept apart because jsdom implements no document navigation and
// makes `location.assign` unforgeable: tests mock this module instead.
export function loadDocument(url: string): void {
  window.location.assign(url);
}

// The same load without a history entry for the page it leaves (issue 2531):
// the auth-proxy recovery navigates away from a boot that failed, and a Back
// out of the proxy's login should not restore that page from the bfcache
// with its button frozen mid-press. Kept beside `loadDocument` for the same
// jsdom reason.
export function replaceDocument(url: string): void {
  window.location.replace(url);
}
