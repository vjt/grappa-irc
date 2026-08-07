import { createSignal } from "solid-js";
import * as api from "./api";
import { setSeveredForFlood } from "./floodSever";
import { getPasskey } from "./passkeys";

// Auth state is a single module-level signal. The token is *the* identity
// — REST calls attach it as `Authorization: Bearer ${token}`, the WS
// connect passes it via the `Sec-WebSocket-Protocol` subprotocol
// (`authToken`, OFF the URL since #95; the `?token=` query-string
// fallback was dropped in #202), and the route guard reads it to redirect
// unauthenticated users.
//
// Persistence: localStorage. Simple, survives reloads + PWA cold-start,
// and the iPhone "Add to Home Screen" surface keeps it across launches.
// Bearer-in-localStorage is exposed to any same-origin XSS, but cicchetto
// renders no untrusted HTML and the same-origin policy plus nginx CSP
// (sub-task 6) is the realistic mitigation. HttpOnly cookie auth would
// require a CSRF surface that the REST contract doesn't currently carry.
//
// Module-singleton signal: every component that calls `token()` shares
// the same reactive subscription. Calling `setToken(...)` from any
// component fans out to all subscribers in one fine-grained update.
// No context provider needed for app-global state.
//
// Navigation is intentionally NOT here — `useNavigate()` from
// `@solidjs/router` is a hook callable only inside route components.
// The Login form navigates after `login()` resolves; the route guard
// in `main.tsx` redirects on unauthenticated state via `createEffect`.

const STORAGE_KEY = "grappa-token";
const SUBJECT_KEY = "grappa-subject";

const [tokenSignal, setTokenSignal] = createSignal<string | null>(
  localStorage.getItem(STORAGE_KEY),
);

export const token = tokenSignal;

export function setToken(value: string | null): void {
  if (value === null) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, value);
    // #630 — acquiring a valid bearer IS a successful (re-)login, so clear
    // the inbound-flood sever latch (floodSever.ts) here on the token-ACQUIRE
    // edge. DELIBERATELY guarded on non-null: the flood sever revokes the
    // bearer, which fires the 401 handler → setToken(null) DURING the sever;
    // clearing on that token-CLEAR edge would erase the latch before the
    // re-login banner ever rendered. So the clear lives ONLY here, never in
    // the null branch / clearLocalAuth / logout.
    setSeveredForFlood(false);
  }
  setTokenSignal(value);
}

// M-cic-6 — `setOn401Handler` used to fire as a module-load side
// effect; importing `auth.ts` mutated the global `api` module's
// handler slot before any explicit bootstrap point ran. That made
// test isolation fragile (every test importing auth.ts wired the
// handler before `vi.clearAllMocks()` could fire) and tied
// dead-token-detect wiring to module-graph load order rather than to
// an explicit application bootstrap. `bootstrapAuth()` is called
// once from `main.tsx` after `applyTheme()` and before `render()`,
// so the handler is wired exactly once and only when the application
// genuinely starts.
function handleUnauthorized(): void {
  setToken(null);
}

// Wire the api module's 401 handler to clear our token. Without this,
// a server-side revoke or token expiry surfaces only as ApiError(401)
// at each call site — the bearer stays in localStorage, the UI looks
// logged-in, the WS keeps reconnect-looping with the dead token, every
// REST call 401s. Centralizing the clear here means: one server 401
// → setToken(null) → token signal goes null → socket.ts createEffect
// disconnects the WS, RequireAuth bounces to /login.
export function bootstrapAuth(): void {
  api.setOn401Handler(handleUnauthorized);
}

export function isAuthenticated(): boolean {
  return tokenSignal() !== null;
}

// #728 — the passkey-second-factor branch used to wrap BOTH the browser
// ceremony and `verifyPasskeySecondFactor` in one `try` and return a bare
// TOTP challenge from the `catch`, discarding the error entirely. Every
// distinct failure — user cancel, no authenticator present, a 401 on a
// genuinely invalid assertion, a network error — collapsed into the same
// silent outcome: the passkey prompt vanishes and a bare "two-factor
// authentication" form appears with no explanation. A user whose phone isn't
// at hand concludes their passkey has stopped working.
//
// The FALLBACK ITSELF is right and is kept for every failure, including a
// server-side 401: the account still has a second factor the user can reach,
// and throwing instead would strand them at the login card with no way in.
// What was wrong is that the reason was thrown away. It rides along now, and
// `Login.tsx` renders it above the TOTP form.
//
// The issue also suggested swallowing `NotAllowedError` (user cancel) and
// surfacing only the rest. Declined: that is exactly the scenario the issue
// itself describes — "they dismissed the OS sheet by accident" — and it is
// the case that most needs the note. Chrome also reports a ceremony TIMEOUT
// as NotAllowedError, so the special case would silence two very different
// events. `null` means no passkey was attempted at all.
export type LoginOutcome =
  | { kind: "authenticated" }
  | { kind: "totp"; challengeToken: string; passkeyError: unknown };

export async function login(
  identifier: string,
  password: string | null,
  captchaToken?: string,
  // #152 — login-Advanced ident + realname (both optional). Blank/absent
  // fields are omitted from the request so a plain/guest login stays a
  // minimal `{identifier}` body and never clobbers visitor defaults.
  // #363 — `incognito` rides the same advanced bundle; only a literal true
  // is sent (absent → an ordinary persistent session).
  advanced?: { ident?: string | null; realname?: string | null; incognito?: boolean },
): Promise<LoginOutcome> {
  const req: api.LoginRequest =
    password !== null && password !== "" ? { identifier, password } : { identifier };
  if (captchaToken !== undefined) req.captcha_token = captchaToken;
  if (advanced?.ident !== null && advanced?.ident !== undefined && advanced.ident !== "") {
    req.ident = advanced.ident;
  }
  if (advanced?.realname !== null && advanced?.realname !== undefined && advanced.realname !== "") {
    req.realname = advanced.realname;
  }
  if (advanced?.incognito === true) {
    req.incognito = true;
  }
  const response = await api.login(req);
  if ("two_factor_required" in response) {
    if ("passkey_options" in response) {
      try {
        const assertion = await getPasskey(response.passkey_options);
        installLogin(await api.verifyPasskeySecondFactor(assertion));
        return { kind: "authenticated" };
      } catch (error) {
        if (response.challenge_token !== null) {
          return {
            kind: "totp",
            challengeToken: response.challenge_token,
            passkeyError: error,
          };
        }
        // No TOTP challenge was minted: passkey is the ONLY second factor,
        // so there is nothing to degrade to and the error must surface.
        throw error;
      }
    }
    return { kind: "totp", challengeToken: response.challenge_token, passkeyError: null };
  }
  installLogin(response);
  return { kind: "authenticated" };
}

function installLogin(response: api.AuthenticatedLoginResponse): void {
  const { token: t, subject } = response;
  localStorage.setItem(SUBJECT_KEY, JSON.stringify(subject));
  setToken(t);
}

export async function verifyTotp(challengeToken: string, code: string): Promise<void> {
  installLogin(await api.verifyTotpLogin(challengeToken, code));
}

export async function loginWithPasskey(identifier: string): Promise<void> {
  const options = await api.getPasskeyLoginOptions(identifier);
  installLogin(await api.verifyPasskeyLogin(await getPasskey(options)));
}

export async function loginWithRecoveryCode(identifier: string, code: string): Promise<void> {
  installLogin(await api.recoverPasskeyLogin(identifier, code));
}

// Visitor session-sharing — install a bearer + subject pair minted via
// `POST /auth/share/consume`. Same effect as `login()` minus the
// request: the consume endpoint already verified the one-shot signed
// token + minted a fresh accounts_sessions row for the SAME visitor.
// Callers (the `/share/:token` SPA route) need a write path that lands
// on the same localStorage keys without re-running the credential
// dance. Without an explicit helper, the consume route would either
// reach for the module-private SUBJECT_KEY or duplicate the JSON write
// + setToken pair — both drift hazards.
export function installSharedSession(token: string, subject: api.Subject): void {
  localStorage.setItem(SUBJECT_KEY, JSON.stringify(subject));
  setToken(token);
}

// C3 — localStorage is mutated by the user (devtools), browser
// extensions, and any successful XSS. JSON.parse without runtime
// narrowing would let a tampered {"kind":"user"} (missing id/name)
// type as Subject and crash downstream consumers reading
// `subject.name` as `string`. Narrow on `unknown` + per-kind shape
// predicate; on any failure, treat the slot as poisoned (clear it
// and return null) so the next login refreshes the canonical shape.
export function getSubject(): api.Subject | null {
  const raw = localStorage.getItem(SUBJECT_KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(SUBJECT_KEY);
    return null;
  }

  if (!isValidSubject(parsed)) {
    localStorage.removeItem(SUBJECT_KEY);
    return null;
  }

  return parsed;
}

// #477 — the ONE persistence predicate. A "persistent identity" is one
// whose identity + scrollback SURVIVE a quit (the quitAll park-all → detach
// path): a registered user, or a NickServ-identified visitor
// (`registered === true`, derived server-side from password_encrypted).
// The inverse — an ephemeral (anon) visitor, or the not-yet-loaded null
// subject — is torn down by a bare logout (its anon row is purged
// server-side). This collapses the class-branching quit()/detach-gate used
// to hand-roll (`kind === "user" || (visitor && registered)`): both asked
// the SAME question — persistence, not class.
//
// SSOT for the persistence question only. It is DELIBERATELY narrow to
// `Subject`: the "deletable account" gate (persistent AND non-admin, on the
// `/me` resource) and the "is admin" gate are DIFFERENT verbs, not folded
// in here — widening the signature to serve them would turn this into a
// type-flag, the exact boundary violation CLAUDE.md's "reuse the verbs, not
// the nouns" forbids.
export function isPersistentIdentity(subject: api.Subject | null): boolean {
  if (subject === null) return false;
  if (subject.kind === "user") return true;
  return subject.registered === true;
}

// C4 — server-side `UserSocket.assign_subject/2` sets
// `socket.assigns.user_name = "visitor:" <> visitor.id` for visitor
// sessions and `User.name` for user sessions. The Phoenix Channel
// `authorize/2` check compares the topic's user prefix to that
// assigns key, so cicchetto MUST construct topics using the same
// prefix or every visitor join is rejected as `forbidden`.
//
// Returns the canonical socket-side identifier for the current
// subject. Read from the persisted Subject (the canonical identity
// store) rather than the `user()` resource so the visitor path
// works without depending on `/me` (which the cluster's controller
// surface doesn't yet support for visitors — Task 30).
export function socketUserName(): string | null {
  const s = getSubject();
  if (s === null) return null;
  if (s.kind === "visitor") return `visitor:${s.id}`;
  return s.name;
}

function isValidSubject(v: unknown): v is api.Subject {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind === "user") {
    return typeof r.id === "string" && typeof r.name === "string";
  }
  if (r.kind === "visitor") {
    return (
      typeof r.id === "string" &&
      // #211 phase 7 — `nick` DROPPED from the visitor subject too
      // (network_slug went in phase 6). A visitor is multi-network;
      // per-network identity lives on GET /networks. Guarding nick here
      // would fail every persisted pre-drop AND post-drop subject → logout
      // loop. Not validated.
      // `registered` is optional for backward compat: a subject persisted
      // before the field landed still validates (read as not-registered).
      // When present it MUST be a boolean.
      (r.registered === undefined || typeof r.registered === "boolean") &&
      // #363 — `incognito` optional for the same backward-compat reason.
      (r.incognito === undefined || typeof r.incognito === "boolean")
    );
  }
  return false;
}

// Drop the local bearer + persisted subject and return the UI to the
// login screen (token signal → null → RequireAuth bounces, socket.ts
// disconnects the WS). The LOCAL half of logout, factored out so #157's
// `deleteAccount` reuses it AFTER the server confirms the wipe — at that
// point the session row is already cascade-gone, so there is nothing to
// revoke server-side.
export function clearLocalAuth(): void {
  localStorage.removeItem(SUBJECT_KEY);
  setToken(null);
}

export async function logout(): Promise<void> {
  const t = tokenSignal();
  if (t !== null) {
    // Server-side revocation is best-effort: even if the bearer is
    // already revoked or the network is gone, we still drop the local
    // token so the UI returns to the login screen. Without this catch,
    // a 401 (expired token) would propagate and leave the user stuck
    // logged-in client-side.
    try {
      await api.logout(t);
    } catch {
      // intentional: see comment above.
    }
  }
  clearLocalAuth();
}

// #364 cicchetto S1 e2e seam — drive a token ROTATION in-context. Sibling
// of `socket.ts:__cic_dropSocketForTests`: a test-only TRIGGER for a real
// production transition. Calling the real `setToken(t)` with a fresh,
// server-valid bearer for the SAME identity fans a genuine reactive
// rotation through the exact production path — socket.ts rebuilds the
// Socket and userTopic.ts/subscribe.ts re-join every topic on it. There
// is no in-UI rotation trigger today (Phase 5 refresh / admin re-issue /
// same-visitor share-consume are the production paths), so a Playwright
// spec needs this seam to exercise the rebuilt-socket re-join end to end.
// Production never calls it; it grants no capability a caller lacks (an
// XSS with a bearer already owns the session, and `login()` reaches
// `setToken` anyway).
declare global {
  interface Window {
    __cic_setTokenForTests?: (token: string | null) => void;
  }
}

if (typeof window !== "undefined") {
  window.__cic_setTokenForTests = (t: string | null) => setToken(t);
}
