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

export function isAuthenticated(): boolean {
  return tokenSignal() !== null;
}

export async function login(name: string, password: string): Promise<void> {
  const { token: t } = await api.login({ name, password });
  setToken(t);
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
  setToken(null);
}
