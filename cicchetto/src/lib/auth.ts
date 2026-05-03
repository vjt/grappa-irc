import { createSignal } from "solid-js";
import * as api from "./api";

// Auth state is a single module-level signal. The token is *the* identity
// — REST calls attach it as `Authorization: Bearer ${token}`, the WS
// connect (sub-task 4) appends it as `?token=...`, and the route guard
// reads it to redirect unauthenticated users.
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
  }
  setTokenSignal(value);
}

// Wire the api module's 401 handler to clear our token. Without this,
// a server-side revoke or token expiry surfaces only as ApiError(401)
// at each call site — the bearer stays in localStorage, the UI looks
// logged-in, the WS keeps reconnect-looping with the dead token, every
// REST call 401s. Centralizing the clear here means: one server 401
// → setToken(null) → token signal goes null → socket.ts createEffect
// disconnects the WS, RequireAuth bounces to /login.
api.setOn401Handler(() => setToken(null));

export function isAuthenticated(): boolean {
  return tokenSignal() !== null;
}

export async function login(
  identifier: string,
  password: string | null,
  captchaToken?: string,
): Promise<void> {
  const req: api.LoginRequest =
    password !== null && password !== "" ? { identifier, password } : { identifier };
  if (captchaToken !== undefined) req.captcha_token = captchaToken;
  const { token: t, subject } = await api.login(req);
  localStorage.setItem(SUBJECT_KEY, JSON.stringify(subject));
  setToken(t);
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
      typeof r.id === "string" && typeof r.nick === "string" && typeof r.network_slug === "string"
    );
  }
  return false;
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
  localStorage.removeItem(SUBJECT_KEY);
  setToken(null);
}
