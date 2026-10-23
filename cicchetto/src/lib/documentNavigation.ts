// Loads `url` as a new document, for the one case an in-app route change gets
// wrong: a target route that reads what its URL carries when it mounts (the
// pairing code in `/pair`'s fragment, issue 2430 X1). solid-router mounts the
// new route before it pushes the URL, so such a route would find nothing;
// a document load is the entry it was built for, the one a camera scan takes.
//
// One line, kept apart because jsdom implements no document navigation and
// makes `location.assign` unforgeable: tests mock this module instead.
export function loadDocument(url: string): void {
  window.location.assign(url);
}
