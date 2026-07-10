// #204 foolproof-login — connecting-screen reassurance copy.
//
// HONESTY CONTRACT (read before editing): these lines are COSMETIC. Login
// is a single blocking request — `POST /auth/login` performs the upstream
// IRC connect INSIDE the call and returns either a token or a
// timeout/admission error. There is NO server-pushed progress stream. The
// rotation exists purely so the user sees motion instead of a dead page
// while that one request is in flight; the individual lines do NOT reflect
// a real server phase and must never be mistaken for telemetry.
//
// vjt Q5 ruling: GENERIC copy — no network-name interpolation, no
// build-time branding constant (the visitor network is server
// compile-time config and `/networks` requires auth, so the name isn't
// available client-side before login resolves anyway).
//
// Index 0 is the anchor line the connecting view renders immediately; the
// component rotates through the rest on a timer (see Login.tsx).

export const CONNECTING_MESSAGES: readonly string[] = [
  "connecting to IRC…",
  "authenticating…",
  "waiting for the welcome banner…",
  "almost there…",
];
