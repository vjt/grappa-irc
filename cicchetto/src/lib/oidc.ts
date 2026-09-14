// #1911 — the browser half of the OIDC round trip.
//
// grappa owns the provider conversation (discovery, PKCE, the token
// exchange); cicchetto owns exactly two moves:
//
//   * leaving — `window.location` at `GET /auth/oidc/authorize`, which
//     302s on to the provider. The navigation is performed by the
//     BROWSER and not by `fetch` on purpose: a same-origin
//     `redirect: "manual"` fetch answers an opaque-redirect response
//     whose `Location` header is unreadable by design, so a fetch-based
//     "get the URL, then navigate" shape cannot exist. The server is the
//     only party that knows the URL anyway — it minted the state.
//
//   * coming back — reading the landing the callback redirects to.
//     `GET /auth/oidc/callback` is a NAVIGATION, not a REST call: the
//     provider 302s the browser at it mid-flow, so it cannot answer
//     JSON to a human standing in a blank tab. It therefore sends the
//     browser home to `/login#oidc=<base64url json>` and this module
//     decodes that. A FRAGMENT rather than a query string is the #1404
//     move: the bearer inside a `session` landing is a live credential,
//     and a fragment is never transmitted with a request and never
//     reaches `Referer` or the server's access log.
//
// The landing shapes are the mirror of `GrappaWeb.OidcController`'s
// `finish/2` payloads. They are deliberately NOT part of the generated
// wire contract (`wireTypes.ts`): the controller answers `json/2` and a
// redirect, which `mix grappa.wire_pin` does not digest — a gap that
// moduledoc records as DEBT rather than an exemption. That is exactly
// why the decode below narrows on `unknown` with shape predicates and
// refuses anything else: there is no generated schema standing between
// the wire and this module, so this one is the boundary.

import type { Subject } from "./api";

// What the callback can send the SPA home with, one arm per outcome:
//
//   * `session` — a full login (`AuthenticatedLoginResponse` envelope,
//     the same shape `POST /auth/login` returns), for an account whose
//     second factor asked nothing further.
//   * `totp` — the account's local factor is still armed; spend the
//     challenge at the ordinary TOTP form.
//   * `linked` — the settings-initiated link round trip came back good.
//   * `error` — refused; `code` is a stable snake_case token.
export type OidcLanding =
  | { kind: "session"; token: string; subject: Subject }
  | { kind: "totp"; challenge_token: string }
  | { kind: "linked"; label: string | null }
  | { kind: "error"; code: string };

const FRAGMENT_KEY = "oidc";

// The one read of the landing. `hash` is the raw `location.hash` (with
// or without its leading `#`); anything that is not a well-formed
// `oidc=` landing of a recognised kind answers `null`, which the caller
// reads as "this is an ordinary visit to /login".
export function readOidcLanding(hash: string): OidcLanding | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const encoded = params.get(FRAGMENT_KEY);
  if (encoded === null || encoded === "") return null;

  const json = base64UrlDecode(encoded);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isOidcLanding(parsed)) return null;
  return parsed;
}

// Scrub the landing out of the address bar once it has been read. A
// `session` landing carries a live bearer: leaving it in `location` and
// in browser history means a reload re-runs the landing (harmless — it
// installs the same token again) and, worse, a shared or screenshotted
// URL carries the credential. Same scrub `ShareConsume` performs on its
// one-shot token.
export function clearOidcLanding(): void {
  if (window.location.hash === "") return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

// Whether this deployment offers the door at all. Probed rather than
// configured, because `/api/config` does not publish it (the wire-pin
// debt named above): a 404 means the deployment has no provider — the
// button would only tease — and any redirect means it does.
export async function oidcLoginAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/auth/oidc/authorize", { redirect: "manual" });
    // Browsers hand a `redirect: "manual"` response back as an
    // opaque-redirect filtered response (`type: "opaqueredirect"`); the
    // status check is for non-browser runtimes that surface the real 302.
    return res.type === "opaqueredirect" || res.status === 302;
  } catch {
    // An unreachable server is not a missing door: no probe result is
    // better than a wrong one, so the button stays hidden and the next
    // login screen render asks again.
    return false;
  }
}

export function beginOidcLogin(): void {
  window.location.assign("/auth/oidc/authorize");
}

// base64url → UTF-8 string, `null` for anything that does not decode.
// `fatal: true` is the point of `TextDecoder` here: a mangled payload
// must fail the decode rather than arrive as replacement characters and
// then fail JSON parsing with a less specific cause.
function base64UrlDecode(value: string): string | null {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isOidcLanding(value: unknown): value is OidcLanding {
  if (typeof value !== "object" || value === null) return false;
  const landing = value as Record<string, unknown>;

  switch (landing.kind) {
    case "session":
      return isSessionLanding(landing);
    case "totp":
      return typeof landing.challenge_token === "string" && landing.challenge_token !== "";
    case "linked":
      return landing.label === null || typeof landing.label === "string";
    case "error":
      return typeof landing.code === "string" && landing.code !== "";
    default:
      return false;
  }
}

// Same narrowing posture as `auth.ts`'s `isValidSubject`: the subject
// rides an unauthenticated fragment, so its shape is checked here rather
// than trusted. An unrecognised shape poisons the WHOLE landing — a
// bearer with no subject is not installable.
function isSessionLanding(landing: Record<string, unknown>): boolean {
  if (typeof landing.token !== "string" || landing.token === "") return false;
  const subject = landing.subject;
  if (typeof subject !== "object" || subject === null) return false;
  const candidate = subject as Record<string, unknown>;

  return (
    (candidate.kind === "user" &&
      typeof candidate.id === "string" &&
      typeof candidate.name === "string") ||
    (candidate.kind === "visitor" && typeof candidate.id === "string")
  );
}
